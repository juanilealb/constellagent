import { ipcMain, dialog, app, BrowserWindow, clipboard } from 'electron'
import { join, relative } from 'path'
import { mkdir, writeFile } from 'fs/promises'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { watch, type FSWatcher } from 'fs'
import { IPC } from '../shared/ipc-channels'
import type { CreateWorktreeProgressEvent } from '../shared/workspace-creation'
import type { AgentRunPromptRequest, AgentRunPromptResult } from '../shared/agent-types'
import { debugLog, toPosixPath } from '@shared/platform'
import { PtyManager } from './pty-manager'
import { GitService } from './git-service'
import { GithubService } from './github-service'
import { FileService } from './file-service'
import { AutomationScheduler, type AutomationConfig } from './automation-scheduler'
import { trustPathForClaude, loadClaudeSettings, saveClaudeSettings, loadJsonFile, saveJsonFile } from './claude-config'
import { loadCodexConfigText, saveCodexConfigText } from './codex-config'

const ptyManager = new PtyManager()
const automationScheduler = new AutomationScheduler(ptyManager)

// Filesystem watchers: dirPath → { watcher, debounceTimer }
const fsWatchers = new Map<string, { watcher: FSWatcher; timer: ReturnType<typeof setTimeout> | null }>()
const AGENT_OUTPUT_LIMIT = 2 * 1024 * 1024
const AGENT_TIMEOUT_MS = 10 * 60 * 1000

function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }
  return error
}

async function runGitOperation<T>(
  operation: string,
  context: Record<string, unknown>,
  op: () => Promise<T>,
): Promise<T> {
  try {
    return await op()
  } catch (error) {
    console.error('[Constellagent] Git operation failed', {
      operation,
      ...context,
      error: serializeError(error),
    })
    throw error
  }
}

function quoteForLog(value: string): string {
  return /[\s"]/g.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

function appendCapped(current: string, nextChunk: string): string {
  const merged = current + nextChunk
  if (merged.length <= AGENT_OUTPUT_LIMIT) return merged
  return merged.slice(merged.length - AGENT_OUTPUT_LIMIT)
}

function resolveGitBashPath(): string | null {
  const candidates = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : null,
    process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe') : null,
  ]

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

function resolveClaudeExecutable(): string {
  const candidates = [
    process.env.CLAUDE_PATH,
    process.env.USERPROFILE ? join(process.env.USERPROFILE, '.local', 'bin', 'claude.exe') : null,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'Claude.exe') : null,
  ]

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return 'claude'
}

function resolveCodexCommand(): { command: string; baseArgs: string[] } {
  const codexScript = process.env.APPDATA
    ? join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    : null

  if (codexScript && existsSync(codexScript)) {
    return { command: 'node', baseArgs: [codexScript] }
  }

  return { command: 'codex', baseArgs: [] }
}

async function runAgentPrompt(payload: AgentRunPromptRequest): Promise<AgentRunPromptResult> {
  const prompt = payload.prompt.trim()
  if (!prompt) {
    return {
      agent: payload.agent,
      ok: false,
      command: '',
      exitCode: null,
      stdout: '',
      stderr: '',
      error: 'Prompt cannot be empty.',
    }
  }

  const rawImagePaths = (payload.imagePaths ?? []).filter((p) => !!p)
  const warnings: string[] = []
  const imagePaths = rawImagePaths.filter((p) => {
    const exists = existsSync(p)
    if (!exists) {
      warnings.push(`Image not found and skipped: ${p}`)
    }
    return exists
  })

  let command = ''
  let args: string[] = []
  let executable = ''
  let env: NodeJS.ProcessEnv = { ...process.env }

  if (payload.agent === 'codex') {
    const resolved = resolveCodexCommand()
    executable = resolved.command
    args = [...resolved.baseArgs, 'exec']
    for (const imagePath of imagePaths) {
      args.push('--image', imagePath)
    }
    args.push(prompt)
    command = [executable, ...args].map(quoteForLog).join(' ')
  } else {
    executable = resolveClaudeExecutable()
    const gitBashPath = resolveGitBashPath()
    if (gitBashPath && !env.CLAUDE_CODE_GIT_BASH_PATH) {
      env = { ...env, CLAUDE_CODE_GIT_BASH_PATH: gitBashPath }
    } else if (!gitBashPath) {
      warnings.push(
        'Claude Code on Windows needs Git Bash. Install Git for Windows or set CLAUDE_CODE_GIT_BASH_PATH.'
      )
    }

    let claudePrompt = prompt
    if (imagePaths.length > 0) {
      const imageList = imagePaths.map((p) => `- ${p}`).join('\n')
      claudePrompt += `\n\nAttached images:\n${imageList}\n\nIf needed, read those files from disk.`
      warnings.push('Claude does not expose a direct --image flag; image paths were appended to the prompt.')
    }

    args = ['-p', claudePrompt]
    command = [executable, ...args].map(quoteForLog).join(' ')
  }

  return await new Promise<AgentRunPromptResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const child = spawn(executable, args, {
      cwd: payload.cwd,
      env,
      windowsHide: true,
    })

    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, AGENT_TIMEOUT_MS)

    const finish = (result: AgentRunPromptResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout = appendCapped(stdout, chunk.toString())
    })

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr = appendCapped(stderr, chunk.toString())
    })

    child.on('error', (error) => {
      finish({
        agent: payload.agent,
        ok: false,
        command,
        exitCode: null,
        stdout,
        stderr,
        error: error.message,
        warnings: warnings.length > 0 ? warnings : undefined,
      })
    })

    child.on('close', (exitCode) => {
      const error = timedOut
        ? `Timed out after ${Math.floor(AGENT_TIMEOUT_MS / 1000)}s.`
        : (exitCode === 0 ? undefined : (stderr.trim() || `Agent process exited with code ${exitCode}.`))

      finish({
        agent: payload.agent,
        ok: !timedOut && exitCode === 0,
        command,
        exitCode,
        stdout,
        stderr,
        error,
        warnings: warnings.length > 0 ? warnings : undefined,
      })
    })
  })
}

export function registerIpcHandlers(): void {
  const normalizeGitPath = (filePath: string): string => toPosixPath(filePath)

  // ── Git handlers ──
  ipcMain.handle(IPC.GIT_LIST_WORKTREES, async (_e, repoPath: string) => {
    return runGitOperation('list-worktrees', { repoPath }, () =>
      GitService.listWorktrees(repoPath),
    )
  })

  ipcMain.handle(IPC.GIT_CREATE_WORKTREE, async (_e, repoPath: string, name: string, branch: string, newBranch: boolean, baseBranch?: string, force?: boolean, requestId?: string) => {
    return runGitOperation(
      'create-worktree',
      { repoPath, name, branch, newBranch, baseBranch, force, requestId },
      () =>
        GitService.createWorktree(
          repoPath,
          name,
          branch,
          newBranch,
          baseBranch,
          force,
          (progress) => {
            const payload: CreateWorktreeProgressEvent = { requestId, ...progress }
            _e.sender.send(IPC.GIT_CREATE_WORKTREE_PROGRESS, payload)
          },
        ),
    )
  })

  ipcMain.handle(IPC.GIT_REMOVE_WORKTREE, async (_e, repoPath: string, worktreePath: string) => {
    return runGitOperation('remove-worktree', { repoPath, worktreePath }, () =>
      GitService.removeWorktree(repoPath, worktreePath),
    )
  })

  ipcMain.handle(IPC.GIT_GET_STATUS, async (_e, worktreePath: string) => {
    const statuses = await runGitOperation('get-status', { worktreePath }, () =>
      GitService.getStatus(worktreePath),
    )
    return statuses.map((s) => ({ ...s, path: normalizeGitPath(s.path) }))
  })

  ipcMain.handle(IPC.GIT_GET_DIFF, async (_e, worktreePath: string, staged: boolean) => {
    const diffs = await runGitOperation('get-diff', { worktreePath, staged }, () =>
      GitService.getDiff(worktreePath, staged),
    )
    return diffs.map((d) => ({ ...d, path: normalizeGitPath(d.path) }))
  })

  ipcMain.handle(IPC.GIT_GET_FILE_DIFF, async (_e, worktreePath: string, filePath: string) => {
    return runGitOperation('get-file-diff', { worktreePath, filePath }, () =>
      GitService.getFileDiff(worktreePath, filePath),
    )
  })

  ipcMain.handle(IPC.GIT_GET_BRANCHES, async (_e, repoPath: string) => {
    return runGitOperation('get-branches', { repoPath }, () =>
      GitService.getBranches(repoPath),
    )
  })

  ipcMain.handle(IPC.GIT_STAGE, async (_e, worktreePath: string, paths: string[]) => {
    return runGitOperation('stage', { worktreePath, paths }, () =>
      GitService.stage(worktreePath, paths),
    )
  })

  ipcMain.handle(IPC.GIT_UNSTAGE, async (_e, worktreePath: string, paths: string[]) => {
    return runGitOperation('unstage', { worktreePath, paths }, () =>
      GitService.unstage(worktreePath, paths),
    )
  })

  ipcMain.handle(IPC.GIT_DISCARD, async (_e, worktreePath: string, paths: string[], untracked: string[]) => {
    return runGitOperation('discard', { worktreePath, paths, untracked }, () =>
      GitService.discard(worktreePath, paths, untracked),
    )
  })

  ipcMain.handle(IPC.GIT_COMMIT, async (_e, worktreePath: string, message: string) => {
    return runGitOperation('commit', { worktreePath, message }, () =>
      GitService.commit(worktreePath, message),
    )
  })

  ipcMain.handle(IPC.GIT_GET_CURRENT_BRANCH, async (_e, worktreePath: string) => {
    return runGitOperation('get-current-branch', { worktreePath }, () =>
      GitService.getCurrentBranch(worktreePath),
    )
  })

  ipcMain.handle(IPC.GIT_GET_DEFAULT_BRANCH, async (_e, repoPath: string) => {
    return runGitOperation('get-default-branch', { repoPath }, () =>
      GitService.getDefaultBranch(repoPath),
    )
  })

  // ── GitHub handlers ──
  ipcMain.handle(IPC.GITHUB_GET_PR_STATUSES, async (_e, repoPath: string, branches: string[]) => {
    return GithubService.getPrStatuses(repoPath, branches)
  })

  // ── PTY handlers ──
  ipcMain.handle(IPC.PTY_CREATE, async (_e, workingDir: string, shell?: string, extraEnv?: Record<string, string>) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win) throw new Error('No window found')
    return ptyManager.create(workingDir, win.webContents, shell, undefined, undefined, extraEnv)
  })

  ipcMain.on(IPC.PTY_WRITE, (_e, ptyId: string, data: string) => {
    ptyManager.write(ptyId, data)
  })

  ipcMain.on(IPC.PTY_RESIZE, (_e, ptyId: string, cols: number, rows: number) => {
    ptyManager.resize(ptyId, cols, rows)
  })

  ipcMain.on(IPC.PTY_DESTROY, (_e, ptyId: string) => {
    ptyManager.destroy(ptyId)
  })

  ipcMain.handle(IPC.PTY_LIST, async () => {
    return ptyManager.list()
  })

  ipcMain.handle(IPC.PTY_REATTACH, async (_e, ptyId: string) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win) throw new Error('No window found')
    return ptyManager.reattach(ptyId, win.webContents)
  })

  // ── File handlers ──
  ipcMain.handle(IPC.FS_GET_TREE, async (_e, dirPath: string) => {
    return FileService.getTree(dirPath)
  })

  ipcMain.handle(IPC.FS_GET_TREE_WITH_STATUS, async (_e, dirPath: string) => {
    const [tree, statuses, topLevel] = await Promise.all([
      FileService.getTree(dirPath),
      GitService.getStatus(dirPath).catch(() => []),
      GitService.getTopLevel(dirPath).catch(() => dirPath),
    ])

    // git status --porcelain paths are relative to repo root, but git ls-files
    // paths (used for tree nodes) are cwd-relative. Convert both to POSIX.
    const prefixRaw = toPosixPath(relative(topLevel, dirPath))
    const prefix = prefixRaw === '.' ? '' : prefixRaw.replace(/^\.\/+/, '')

    // Build map: dirPath-relative path → git status
    const statusMap = new Map<string, string>()
    for (const s of statuses) {
      let p = normalizeGitPath(s.path)
      // Handle renamed files: "old -> new" — use the new path
      if (p.includes(' -> ')) {
        p = p.split(' -> ')[1] ?? p
      }
      // Strip repo-root prefix to get dirPath-relative path
      if (prefix) {
        if (p === prefix) p = ''
        else if (p.startsWith(`${prefix}/`)) p = p.slice(prefix.length + 1)
      }
      statusMap.set(p, s.status)
    }

    // Attach gitStatus to nodes, propagate to parent dirs
    function annotate(nodes: Awaited<ReturnType<typeof FileService.getTree>>): boolean {
      let hasStatus = false
      for (const node of nodes) {
        const rel = toPosixPath(relative(dirPath, node.path))

        if (node.type === 'file') {
          const st = statusMap.get(rel)
          if (st) {
            ;(node as any).gitStatus = st
            hasStatus = true
          }
        } else if (node.children) {
          const childHasStatus = annotate(node.children)
          if (childHasStatus) {
            ;(node as any).gitStatus = 'modified'
            hasStatus = true
          }
        }
      }
      return hasStatus
    }

    annotate(tree)
    return tree
  })

  ipcMain.handle(IPC.FS_READ_FILE, async (_e, filePath: string) => {
    return FileService.readFile(filePath)
  })

  ipcMain.handle(IPC.FS_WRITE_FILE, async (_e, filePath: string, content: string) => {
    return FileService.writeFile(filePath, content)
  })

  // ── Filesystem watcher handlers ──
  ipcMain.handle(IPC.FS_WATCH_START, (_e, dirPath: string) => {
    if (fsWatchers.has(dirPath)) return // already watching

    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win) return

    try {
      const watcher = watch(dirPath, { recursive: true }, (_eventType, filename) => {
        const fileNameText = typeof filename === 'string'
          ? filename
          : Buffer.isBuffer(filename)
            ? filename.toString('utf-8')
            : ''

        // For .git/ changes, only notify on meaningful state changes (commit, stage, branch switch)
        // Ignore noisy internals like objects/, logs/, COMMIT_EDITMSG
        if (fileNameText && (fileNameText.startsWith('.git/') || fileNameText.startsWith('.git\\'))) {
          const f = fileNameText.replaceAll('\\', '/')
          const isStateChange =
            f === '.git/index' || f === '.git/HEAD' || f.startsWith('.git/refs/')
          if (!isStateChange) return
        }

        const entry = fsWatchers.get(dirPath)
        if (!entry) return

        // Debounce: wait 500ms of quiet before notifying
        if (entry.timer) clearTimeout(entry.timer)
        entry.timer = setTimeout(() => {
          if (!win.isDestroyed()) {
            win.webContents.send(IPC.FS_WATCH_CHANGED, dirPath)
          }
        }, 500)
      })

      fsWatchers.set(dirPath, { watcher, timer: null })
    } catch {
      // Directory may not exist or be inaccessible — ignore
    }
  })

  ipcMain.on(IPC.FS_WATCH_STOP, (_e, dirPath: string) => {
    const entry = fsWatchers.get(dirPath)
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.watcher.close()
      fsWatchers.delete(dirPath)
    }
  })

  // ── App handlers ──
  ipcMain.handle(IPC.APP_SELECT_DIRECTORY, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Repository',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Accepts a path directly (for testing — avoids dialog.showOpenDialog)
  ipcMain.handle(IPC.APP_ADD_PROJECT_PATH, async (_e, dirPath: string) => {
    const { stat } = await import('fs/promises')
    try {
      const s = await stat(dirPath)
      if (!s.isDirectory()) return null
      return dirPath
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC.APP_GET_DATA_PATH, async () => {
    return app.getPath('userData')
  })

  // ── Claude Code trust ──
  ipcMain.handle(IPC.CLAUDE_TRUST_PATH, async (_e, dirPath: string) => {
    await trustPathForClaude(dirPath)
  })

  // ── Claude Code hooks ──
  function getHookScriptPath(name: string): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'claude-hooks', name)
    }
    return join(__dirname, '..', '..', 'claude-hooks', name)
  }

  function getCodexHookScriptPath(name: string): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'codex-hooks', name)
    }
    return join(__dirname, '..', '..', 'codex-hooks', name)
  }

  // Stable identifiers to match our hook entries regardless of full path.
  const CLAUDE_HOOK_IDENTIFIERS = [
    'claude-hooks/notify.js',
    'claude-hooks/activity.js',
  ]

  function normalizeHookText(value: string): string {
    return toPosixPath(value).replace(/\/+/g, '/').toLowerCase()
  }

  function commandHasIdentifier(command: string | undefined, identifiers: readonly string[]): boolean {
    if (!command) return false
    const normalized = normalizeHookText(command)
    return identifiers.some((id) => normalized.includes(id))
  }

  function buildNodeHookCommand(scriptPath: string): string {
    const escapedPath = scriptPath.replace(/"/g, '""')
    return `node "${escapedPath}"`
  }

  function isOurHook(rule: { hooks?: Array<{ command?: string }> }): boolean {
    return !!rule.hooks?.some((h) => commandHasIdentifier(h.command, CLAUDE_HOOK_IDENTIFIERS))
  }

  ipcMain.handle(IPC.CLAUDE_CHECK_HOOKS, async () => {
    const settings = await loadClaudeSettings()
    const hooks = settings.hooks as Record<string, unknown[]> | undefined
    if (!hooks) return { installed: false }

    const hasStop = (hooks.Stop as Array<{ hooks?: Array<{ command?: string }> }> | undefined)?.some(isOurHook)
    const hasNotification = (hooks.Notification as Array<{ hooks?: Array<{ command?: string }> }> | undefined)?.some(isOurHook)
    const hasPromptSubmit = (hooks.UserPromptSubmit as Array<{ hooks?: Array<{ command?: string }> }> | undefined)?.some(isOurHook)
    return { installed: !!(hasStop && hasNotification && hasPromptSubmit) }
  })

  ipcMain.handle(IPC.CLAUDE_INSTALL_HOOKS, async () => {
    const settings = await loadClaudeSettings()
    const notifyPath = getHookScriptPath('notify.js')
    const activityPath = getHookScriptPath('activity.js')

    const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>

    // Helper: remove stale entries with old paths, then add current one
    function ensureHook(event: string, scriptPath: string, matcher = '') {
      const rules = (hooks[event] ?? []) as Array<Record<string, unknown>>
      const filtered = rules.filter((rule) => !isOurHook(rule as { hooks?: Array<{ command?: string }> }))
      filtered.push({ matcher, hooks: [{ type: 'command', command: buildNodeHookCommand(scriptPath) }] })
      hooks[event] = filtered
    }

    ensureHook('Stop', notifyPath)
    ensureHook('Notification', notifyPath)
    ensureHook('UserPromptSubmit', activityPath)
    settings.hooks = hooks

    await saveClaudeSettings(settings)
    debugLog('Claude hooks installed', {
      events: ['Stop', 'Notification', 'UserPromptSubmit'],
      notifyPath,
      activityPath,
    })
    return { success: true }
  })

  ipcMain.handle(IPC.CLAUDE_UNINSTALL_HOOKS, async () => {
    const settings = await loadClaudeSettings()
    const hooks = settings.hooks as Record<string, unknown[]> | undefined
    if (!hooks) {
      debugLog('Claude hooks uninstall skipped (no hooks configured)')
      return { success: true }
    }

    function removeHook(event: string) {
      const rules = (hooks![event] ?? []) as Array<{ hooks?: Array<{ command?: string }> }>
      hooks![event] = rules.filter((rule) => !isOurHook(rule))
      if ((hooks![event] as unknown[]).length === 0) delete hooks![event]
    }

    removeHook('Stop')
    removeHook('Notification')
    removeHook('UserPromptSubmit')

    if (Object.keys(hooks).length === 0) delete settings.hooks
    await saveClaudeSettings(settings)
    debugLog('Claude hooks uninstalled', {
      events: ['Stop', 'Notification', 'UserPromptSubmit'],
    })
    return { success: true }
  })

  // ── Codex notify hook ──
  const CODEX_NOTIFY_IDENTIFIERS = [
    'codex-hooks/notify.js',
  ]
  const TABLE_HEADER_RE = /^\s*\[[^\n]+\]\s*$/m
  const NOTIFY_ASSIGNMENT_RE = /^\s*notify\s*=/

  function tomlEscape(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  }

  function firstTableHeaderIndex(configText: string): number {
    const match = configText.match(TABLE_HEADER_RE)
    return match?.index ?? -1
  }

  function topLevelSection(configText: string): string {
    const firstTableIndex = firstTableHeaderIndex(configText)
    return firstTableIndex === -1 ? configText : configText.slice(0, firstTableIndex)
  }

  function textHasAnyCodexNotifyIdentifier(text: string): boolean {
    const normalized = normalizeHookText(text)
    return CODEX_NOTIFY_IDENTIFIERS.some((id) => normalized.includes(id))
  }

  function hasOurCodexNotify(configText: string): boolean {
    return textHasAnyCodexNotifyIdentifier(topLevelSection(configText))
  }

  function stripNotifyAssignments(configText: string, shouldStrip: (assignment: string) => boolean = () => true): string {
    const lines = configText.split('\n')
    const kept: string[] = []
    let i = 0

    while (i < lines.length) {
      const line = lines[i]
      if (!NOTIFY_ASSIGNMENT_RE.test(line)) {
        kept.push(line)
        i += 1
        continue
      }

      let end = i
      const startsArray = line.includes('[')
      const endsArray = line.includes(']')
      if (startsArray && !endsArray) {
        let j = i + 1
        while (j < lines.length) {
          end = j
          if (lines[j].includes(']')) break
          j += 1
        }
      }

      const assignment = lines.slice(i, end + 1).join('\n')
      if (!shouldStrip(assignment)) {
        kept.push(...lines.slice(i, end + 1))
      }
      i = end + 1
    }

    return kept.join('\n')
  }

  function insertTopLevelNotify(configText: string, notifyLine: string): string {
    const withoutNotify = configText.trimEnd()
    if (!withoutNotify) return `${notifyLine}\n`

    const firstTableIndex = firstTableHeaderIndex(withoutNotify)
    if (firstTableIndex === -1) {
      return `${withoutNotify}\n${notifyLine}\n`
    }

    const beforeTables = withoutNotify.slice(0, firstTableIndex).trimEnd()
    const tablesAndBelow = withoutNotify.slice(firstTableIndex).replace(/^\n+/, '')

    const rebuilt = beforeTables
      ? `${beforeTables}\n${notifyLine}\n\n${tablesAndBelow}`
      : `${notifyLine}\n\n${tablesAndBelow}`

    return `${rebuilt.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
  }

  ipcMain.handle(IPC.CODEX_CHECK_NOTIFY, async () => {
    const config = await loadCodexConfigText()
    return { installed: hasOurCodexNotify(config) }
  })

  ipcMain.handle(IPC.CODEX_INSTALL_NOTIFY, async () => {
    const notifyPath = getCodexHookScriptPath('notify.js')
    const notifyLine = `notify = ["node", "${tomlEscape(notifyPath)}"]`
    let config = await loadCodexConfigText()

    // `notify` must be at true top-level in TOML. Appending at EOF can accidentally
    // nest it under the last table (for example `[projects."..."]`), which Codex ignores.
    config = stripNotifyAssignments(config)
    config = insertTopLevelNotify(config, notifyLine)

    await saveCodexConfigText(config)
    debugLog('Codex notify hook installed', { notifyPath })
    return { success: true }
  })

  ipcMain.handle(IPC.CODEX_UNINSTALL_NOTIFY, async () => {
    let config = await loadCodexConfigText()
    if (!textHasAnyCodexNotifyIdentifier(config)) {
      debugLog('Codex notify hook uninstall skipped (no matching assignment)')
      return { success: true }
    }

    config = stripNotifyAssignments(config, (assignment) => textHasAnyCodexNotifyIdentifier(assignment))
    config = config.replace(/\n{3,}/g, '\n\n').trimEnd()
    if (config) config += '\n'

    await saveCodexConfigText(config)
    debugLog('Codex notify hook uninstalled')
    return { success: true }
  })

  // -- Agent chat --
  ipcMain.handle(IPC.AGENT_RUN_PROMPT, async (_e, payload: AgentRunPromptRequest) => {
    return runAgentPrompt(payload)
  })

  // ── Automation handlers ──
  ipcMain.handle(IPC.AUTOMATION_CREATE, async (_e, automation: AutomationConfig) => {
    automationScheduler.schedule(automation)
  })

  ipcMain.handle(IPC.AUTOMATION_UPDATE, async (_e, automation: AutomationConfig) => {
    automationScheduler.schedule(automation) // reschedules
  })

  ipcMain.handle(IPC.AUTOMATION_DELETE, async (_e, automationId: string) => {
    automationScheduler.unschedule(automationId)
  })

  ipcMain.handle(IPC.AUTOMATION_RUN_NOW, async (_e, automation: AutomationConfig) => {
    automationScheduler.runNow(automation)
  })

  ipcMain.handle(IPC.AUTOMATION_STOP, async (_e, automationId: string) => {
    automationScheduler.unschedule(automationId)
  })

  // Load persisted automations and schedule enabled ones on startup
  ipcMain.handle(IPC.AUTOMATION_LIST, async () => {
    // List is just for init — renderer manages the list in store
    // Main process uses this to bootstrap scheduler from persisted state
    return null
  })

  // ── Clipboard handlers ──
  ipcMain.handle(IPC.CLIPBOARD_SAVE_IMAGE, async () => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const buf = img.toPNG()
    const filePath = join(tmpdir(), `constellagent-paste-${Date.now()}.png`)
    await writeFile(filePath, buf)
    return filePath
  })

  // ── State persistence handlers ──
  const stateFilePath = () =>
    join(app.getPath('userData'), 'constellagent-state.json')

  ipcMain.handle(IPC.STATE_SAVE, async (_e, data: unknown) => {
    await mkdir(app.getPath('userData'), { recursive: true })
    await saveJsonFile(stateFilePath(), data)
  })

  // Synchronous save for beforeunload — guarantees state is written before window closes
  ipcMain.on(IPC.STATE_SAVE_SYNC, (event, data: unknown) => {
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      writeFileSync(stateFilePath(), JSON.stringify(data, null, 2), 'utf-8')
      event.returnValue = true
    } catch {
      event.returnValue = false
    }
  })

  ipcMain.handle(IPC.STATE_LOAD, async () => {
    return loadJsonFile(stateFilePath(), null)
  })
}
