export type AgentKind = 'codex' | 'claude'

export interface AgentRunPromptRequest {
  agent: AgentKind
  prompt: string
  cwd: string
  imagePaths?: string[]
}

export interface AgentRunPromptResult {
  agent: AgentKind
  ok: boolean
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  error?: string
  warnings?: string[]
}
