import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent } from 'react'
import type { AgentKind } from '@shared/agent-types'
import { useAppStore } from '../../store/app-store'
import styles from './AgentChatPanel.module.css'

type ChatRole = 'user' | 'assistant' | 'system'

interface ChatMessage {
  id: string
  role: ChatRole
  agent: AgentKind
  text: string
  images: string[]
  createdAt: number
}

interface Props {
  workspaceId: string
  worktreePath: string
  isActive: boolean
}

function compactForContext(text: string): string {
  const max = 1200
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n...[truncated]`
}

function buildPromptWithContext(history: ChatMessage[], userPrompt: string): string {
  const context = history
    .filter((m) => m.role !== 'system')
    .slice(-8)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}:\n${compactForContext(m.text)}`)
    .join('\n\n')

  if (!context) return userPrompt
  return `Conversation so far:\n${context}\n\nLatest user request:\n${userPrompt}`
}

function formatResultText(
  stdout: string,
  stderr: string,
  error: string | undefined,
  warnings: string[] | undefined,
): string {
  const chunks: string[] = []
  const main = stdout.trim() || stderr.trim()
  if (main) chunks.push(main)
  if (!main && error) chunks.push(error)
  if (warnings && warnings.length > 0) {
    chunks.push(`Warnings:\n${warnings.map((w) => `- ${w}`).join('\n')}`)
  }
  return chunks.join('\n\n').trim() || 'No output from agent.'
}

export function AgentChatPanel({ workspaceId, worktreePath, isActive }: Props) {
  const [agentByWorkspace, setAgentByWorkspace] = useState<Record<string, AgentKind>>({})
  const [draftByWorkspace, setDraftByWorkspace] = useState<Record<string, string>>({})
  const [attachmentsByWorkspace, setAttachmentsByWorkspace] = useState<Record<string, string[]>>({})
  const [historyByWorkspace, setHistoryByWorkspace] = useState<Record<string, ChatMessage[]>>({})
  const [runningByWorkspace, setRunningByWorkspace] = useState<Record<string, boolean>>({})
  const addToast = useAppStore((s) => s.addToast)
  const focusOrCreateTerminal = useAppStore((s) => s.focusOrCreateTerminal)
  const listRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const agent = agentByWorkspace[workspaceId] ?? 'codex'
  const draft = draftByWorkspace[workspaceId] ?? ''
  const attachments = attachmentsByWorkspace[workspaceId] ?? []
  const history = historyByWorkspace[workspaceId] ?? []
  const running = runningByWorkspace[workspaceId] ?? false

  const canSend = useMemo(() => {
    if (running) return false
    return draft.trim().length > 0 || attachments.length > 0
  }, [running, draft, attachments.length])

  const setAgent = (value: AgentKind) => {
    setAgentByWorkspace((prev) => ({ ...prev, [workspaceId]: value }))
  }

  const setDraft = (value: string) => {
    setDraftByWorkspace((prev) => ({ ...prev, [workspaceId]: value }))
  }

  const setAttachments = (value: string[]) => {
    setAttachmentsByWorkspace((prev) => ({ ...prev, [workspaceId]: value }))
  }

  const appendHistory = (message: ChatMessage) => {
    setHistoryByWorkspace((prev) => ({
      ...prev,
      [workspaceId]: [...(prev[workspaceId] ?? []), message],
    }))
  }

  useEffect(() => {
    if (!isActive) return
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [history, running, isActive])

  const addAttachmentPath = (path: string) => {
    if (!path) return
    if (attachments.includes(path)) return
    setAttachments([...attachments, path])
  }

  const handlePickImages = () => {
    fileInputRef.current?.click()
  }

  const handleFilesSelected = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    const picked = files
      .map((file) => (file as File & { path?: string }).path)
      .filter((path): path is string => !!path)

    if (picked.length === 0 && files.length > 0) {
      addToast({
        id: crypto.randomUUID(),
        message: 'Could not resolve image path. Try paste image instead.',
        type: 'error',
      })
    }

    for (const path of picked) addAttachmentPath(path)
    e.target.value = ''
  }

  const handlePasteImageButton = async () => {
    const path = await window.api.clipboard.saveImage()
    if (!path) {
      addToast({
        id: crypto.randomUUID(),
        message: 'Clipboard does not contain an image.',
        type: 'error',
      })
      return
    }
    addAttachmentPath(path)
  }

  const handlePasteInTextarea = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const hasImage = Array.from(e.clipboardData.items).some((item) => item.type.startsWith('image/'))
    if (!hasImage) return
    e.preventDefault()
    await handlePasteImageButton()
  }

  const removeAttachment = (target: string) => {
    setAttachments(attachments.filter((path) => path !== target))
  }

  const sendPrompt = async () => {
    if (!canSend) return

    const trimmed = draft.trim()
    const userText = trimmed || 'Analyze the attached images.'
    const inputImages = [...attachments]

    appendHistory({
      id: crypto.randomUUID(),
      role: 'user',
      agent,
      text: userText,
      images: inputImages,
      createdAt: Date.now(),
    })

    setDraft('')
    setAttachments([])
    setRunningByWorkspace((prev) => ({ ...prev, [workspaceId]: true }))

    try {
      const promptWithContext = buildPromptWithContext(history, userText)
      const result = await window.api.agent.runPrompt({
        agent,
        prompt: promptWithContext,
        cwd: worktreePath,
        imagePaths: inputImages,
      })

      appendHistory({
        id: crypto.randomUUID(),
        role: result.ok ? 'assistant' : 'system',
        agent,
        text: formatResultText(result.stdout, result.stderr, result.error, result.warnings),
        images: [],
        createdAt: Date.now(),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to run agent.'
      appendHistory({
        id: crypto.randomUUID(),
        role: 'system',
        agent,
        text: message,
        images: [],
        createdAt: Date.now(),
      })
    } finally {
      setRunningByWorkspace((prev) => ({ ...prev, [workspaceId]: false }))
    }
  }

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <span className={styles.label}>Agent</span>
          <select
            className={styles.agentSelect}
            value={agent}
            onChange={(e) => setAgent(e.target.value as AgentKind)}
            disabled={running}
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
        </div>
        <button className={styles.secondaryButton} onClick={focusOrCreateTerminal}>
          Terminal
        </button>
      </div>

      <div className={styles.messages} ref={listRef}>
        {history.length === 0 ? (
          <div className={styles.emptyState}>
            <p>Ask with Codex or Claude in the current workspace.</p>
            <p>Keep using terminal tabs in parallel for manual commands.</p>
          </div>
        ) : (
          history.map((message) => (
            <div key={message.id} className={`${styles.message} ${styles[message.role]}`}>
              <div className={styles.messageMeta}>
                <span className={styles.messageRole}>{message.role}</span>
                <span className={styles.messageAgent}>{message.agent}</span>
              </div>
              <pre className={styles.messageText}>{message.text}</pre>
              {message.images.length > 0 && (
                <div className={styles.messageImages}>
                  {message.images.map((path) => (
                    <span key={path} className={styles.imagePill}>{path}</span>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {attachments.length > 0 && (
        <div className={styles.attachments}>
          {attachments.map((path) => (
            <button
              key={path}
              className={styles.attachment}
              onClick={() => removeAttachment(path)}
              title="Remove image"
            >
              {path}
            </button>
          ))}
        </div>
      )}

      <div className={styles.composer}>
        <textarea
          className={styles.textarea}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={handlePasteInTextarea}
          placeholder="Ask about code, diffs, or paste a screenshot..."
          disabled={running}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void sendPrompt()
            }
          }}
        />

        <div className={styles.actions}>
          <div className={styles.leftActions}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className={styles.fileInput}
              onChange={handleFilesSelected}
            />
            <button className={styles.secondaryButton} onClick={handlePickImages} disabled={running}>
              Attach image
            </button>
            <button className={styles.secondaryButton} onClick={handlePasteImageButton} disabled={running}>
              Paste image
            </button>
          </div>

          <button className={styles.sendButton} onClick={sendPrompt} disabled={!canSend}>
            {running ? 'Running...' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}
