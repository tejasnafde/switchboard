/** Shared types between main process and renderer */

// ─── Terminal ────────────────────────────────────────────────────────

export interface TerminalCreateOptions {
  id: string
  shell?: string
  cwd?: string
  cols?: number
  rows?: number
  env?: Record<string, string>
  /** Command to run in the terminal after shell init */
  initialCommand?: string
  /** Wait for this string in ANY terminal's output before running initialCommand */
  waitFor?: string
}

export interface TerminalResizePayload {
  id: string
  cols: number
  rows: number
}

export interface TerminalDataPayload {
  id: string
  data: string
}

export interface TerminalExitPayload {
  id: string
  exitCode: number
  signal?: number
}

export type TerminalStatus = 'running' | 'exited' | 'error'

export interface TerminalInfo {
  id: string
  label: string
  status: TerminalStatus
  cwd: string
  command?: string
}

// ─── Agent ───────────────────────────────────────────────────────────

export type AgentType = 'claude-code' | 'codex' | 'opencode'

export const AGENT_TYPES: readonly AgentType[] = ['claude-code', 'codex', 'opencode'] as const

export function isAgentType(v: unknown): v is AgentType {
  return AGENT_TYPES.includes(v as AgentType)
}

/** Canonical id for the seed-default instance of an agent kind. */
export function defaultInstanceId(kind: AgentType): string {
  return `${kind}-default`
}

/**
 * Human-readable label for an agent type. Use everywhere the UI needs to
 * display the agent's name — status bar, message-bubble author, notifications,
 * export headers — so we never drift to hardcoded "Claude" strings.
 */
export function agentLabel(type: AgentType | undefined): string {
  if (type === 'codex') return 'Codex'
  if (type === 'opencode') return 'OpenCode'
  return 'Claude Code'
}

/** Short form (message bubble header, session picker rows). */
export function agentShortLabel(type: AgentType | undefined): string {
  if (type === 'codex') return 'Codex'
  if (type === 'opencode') return 'OpenCode'
  return 'Claude'
}

export type AgentStatus = 'idle' | 'running' | 'thinking' | 'error' | 'exited'

/**
 * A slash command/skill exposed by an agent runtime (Claude Code's
 * `/commit`, Codex's project skills, etc.) — surfaced in the chat input's
 * slash menu alongside Switchboard's built-ins so the user can fire them
 * directly without switching context.
 *
 * Source determines the prefix used when the command is selected:
 *   - `claude-code`: prefix `/<name> ` (Claude SDK reads `/cmd` from the
 *     prompt and dispatches its own `SlashCommand` handler).
 *   - `codex`: prefix `$<name> ` (Codex's app-server uses `$skill`
 *     invocations in user input).
 *   - `switchboard`: built-in client-side action, no agent prefix —
 *     handled by `SlashCommand.run()` instead.
 */
export interface ProviderSkill {
  name: string
  description?: string
  argumentHint?: string
  source: 'claude-code' | 'codex' | 'opencode'
}

/**
 * A named credential set for an agent kind. Multiple instances per kind
 * are supported (e.g. `claude-work`, `claude-personal`). The renderer
 * receives this redacted shape — secret values stay in main, never
 * cross IPC. `envKeys` lists which env vars are configured so the
 * Settings UI can show "ANTHROPIC_API_KEY ●●●" without leaking it.
 */
export interface ProviderInstance {
  id: string
  agentType: AgentType
  displayName: string
  accentColor: string | null
  authMode: 'env' | 'oauth_dir'
  envKeys: string[]
  oauthDir: string | null
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface AgentStartOptions {
  id: string
  type: AgentType
  cwd: string
  resumeSessionId?: string
}

export interface AgentSendPayload {
  id: string
  message: string
  context?: TerminalContext[]
}

export interface TerminalContext {
  text: string
  paneName: string
  command?: string
  timestamp: number
}

// ─── Messages (normalized conversation format) ──────────────────────

export type MessageRole = 'user' | 'assistant' | 'system'

export interface ToolCall {
  id: string
  name: string
  input: string
  output?: string
}

export interface MessageImage {
  /** Data URL or object URL for rendering */
  url: string
  /** Optional MIME type (e.g. image/png) */
  mimeType?: string
  /** Optional filename */
  name?: string
}

export interface PlanAttachment {
  /** Unique ID of the plan (used as messageId anchor) */
  id: string
  /** Plan content as Markdown */
  markdown: string
}

export interface QuestionAttachment {
  requestId: string
  questions: Array<{
    id: string
    header: string
    question: string
    options: Array<{ label: string; description?: string }>
    multiSelect: boolean
  }>
  /** 'pending' | 'answered' */
  status: 'pending' | 'answered'
  /** Selected labels per question (parallel to questions array) */
  answers?: string[][]
}

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  toolCalls?: ToolCall[]
  images?: MessageImage[]
  timestamp: number
  context?: TerminalContext[]
  /** For approval requests — shows Accept/Reject UI */
  approval?: {
    toolName: string
    detail: string
    status: 'pending' | 'accepted' | 'rejected'
  }
  /** Plan proposal from agent exiting plan mode */
  plan?: PlanAttachment
  /** AskUserQuestion request */
  question?: QuestionAttachment
  /**
   * Set when canUseTool hard-denied a tool (e.g. Plan mode blocking Write).
   * Renders as a small pill in the chat stream so the user sees the policy
   * block, not just the agent's prose reaction.
   */
  denial?: {
    toolName: string
    reason: string
    mode: 'plan' | 'sandbox' | 'accept-edits' | 'full-access'
  }
  /**
   * Wall-clock duration of the assistant turn that produced this message,
   * in ms. Set on the LAST assistant message of a turn when `turn.completed`
   * fires. Rendered by MessageBubble as "Worked for X.Xs" under the bubble,
   * Cursor-style.
   */
  turnDurationMs?: number
  /**
   * Pill-aware display body with `[[pill:<id>]]` tokens. `content` holds
   * the expanded text the agent saw; `displayBody` is what the bubble
   * renders so chips reappear after reload. Persisted in the messages
   * table and merged back during JSONL load via content match.
   */
  displayBody?: string
  /** Pill metadata keyed by token id. Persisted as JSON alongside `displayBody`. */
  pillsMeta?: Record<string, { label: string; kind: 'file' | 'terminal' | 'chat-message' }>
}

export interface AgentMessagePayload {
  agentId: string
  message: ChatMessage
}

export interface AgentStatusPayload {
  agentId: string
  status: AgentStatus
}

export interface AgentErrorPayload {
  agentId: string
  error: string
}

// ─── Projects & Sessions ─────────────────────────────────────────

export type SessionSource = 'claude-code' | 'codex' | 'cursor' | 'switchboard'

export interface SessionSummary {
  id: string
  source: SessionSource
  title: string
  startedAt: number
  messageCount: number
  filePath: string
  /**
   * Set if this session was created in worktree mode or had a worktree
   * assigned via the branch picker. The renderer passes this through to
   * `addSession` so the agent's cwd routes via `worktreePath ?? projectPath`.
   */
  worktreePath?: string | null
  worktreeBranch?: string | null
}

export interface Project {
  path: string
  name: string
  sessions: SessionSummary[]
  /** Sidebar workspace this project belongs to. `null` = "Ungrouped". */
  workspaceId?: string | null
}

/**
 * Sidebar workspace — the outer grouping above projects. Users assign
 * projects to a workspace; projects with `workspaceId == null` render
 * under the implicit "Ungrouped" pseudo-workspace at the bottom.
 */
export interface Workspace {
  id: string
  name: string
  color: string | null
  sortOrder: number
  createdAt: number
}

// ─── Conversation persistence ───────────────────────────────────

export interface CreateConversationParams {
  id: string
  projectPath: string
  agentType: AgentType
  title?: string
  /** Set when the session was created in worktree mode. */
  worktreePath?: string | null
  worktreeBranch?: string | null
}

export interface SaveMessageParams {
  id: string
  conversationId: string
  role: MessageRole
  content: string
  toolCalls?: string
  images?: string
  /** Pill-tokenized body (`[[pill:<id>]]` form). Persisted alongside `content`
   *  so reloaded user messages can re-render their chips. */
  displayBody?: string
  /** JSON-serialized pill metadata map keyed by token id. */
  pillsMeta?: string
}

export interface ConversationRow {
  id: string
  project_path: string
  agent_type: string
  session_id: string | null
  title: string
  created_at: number
  updated_at: number
}
