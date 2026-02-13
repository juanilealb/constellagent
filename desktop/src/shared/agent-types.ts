export type AgentKind = 'codex' | 'claude'

export interface AgentChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AgentRunPromptRequest {
  agent: AgentKind
  cwd: string
  prompt?: string
  messages?: AgentChatMessage[]
  imagePaths?: string[]
  model?: string
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
