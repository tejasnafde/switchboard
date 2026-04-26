/**
 * Provider runtime events — the wire format for main → renderer provider updates.
 *
 * Lives in `shared/` so both the preload (main-scope) and renderer can type
 * `window.api.provider.onEvent` against the same discriminated union. Keeping
 * these types out of `src/main/provider/types.ts` (main-only) prevents the
 * "as any" casts that used to flood ChatPanel.
 *
 * Adapter-specific types (ProviderAdapter interface, SessionStartOpts, etc.)
 * stay in `src/main/provider/types.ts`; only the wire events are shared.
 */

export type ProviderSessionStatus =
  | 'connecting'
  | 'idle'
  | 'running'
  | 'error'
  | 'stopped'

export type ApprovalDecision = 'approve' | 'deny'

export type RuntimeMode = 'plan' | 'sandbox' | 'accept-edits' | 'full-access'

export type ProviderKind = 'claude' | 'codex' | 'opencode'

// ─── Event union ───────────────────────────────────────────────

export type RuntimeEvent =
  | RuntimeContentEvent
  | RuntimeToolStartedEvent
  | RuntimeToolCompletedEvent
  | RuntimeToolDeniedEvent
  | RuntimeRequestOpenedEvent
  | RuntimeRequestClosedEvent
  | RuntimeTurnCompletedEvent
  | RuntimeErrorEvent
  | RuntimeStatusEvent
  | RuntimeSessionEvent
  | RuntimeContextWindowEvent
  | RuntimePlanProposedEvent
  | RuntimeQuestionAskedEvent
  | RuntimeQuestionAnsweredEvent

export interface RuntimeContentEvent {
  type: 'content'
  threadId: string
  messageId: string
  text: string
  streamKind: 'assistant' | 'reasoning' | 'plan'
}

export interface RuntimeToolStartedEvent {
  type: 'tool.started'
  threadId: string
  toolId: string
  toolName: string
  input: unknown
}

export interface RuntimeToolCompletedEvent {
  type: 'tool.completed'
  threadId: string
  toolId: string
  output?: string
}

/**
 * Emitted when `canUseTool` hard-denies a tool call (e.g. Plan mode blocking
 * Write). Causes the UI to render a denial pill in the chat stream so the
 * user sees the policy-level block, not just the agent's text reaction.
 */
export interface RuntimeToolDeniedEvent {
  type: 'tool.denied'
  threadId: string
  toolName: string
  reason: string
  mode: RuntimeMode
}

export interface RuntimeRequestOpenedEvent {
  type: 'request.opened'
  threadId: string
  requestId: string
  requestType: 'command' | 'file' | 'tool'
  toolName: string
  detail: string
}

export interface RuntimeRequestClosedEvent {
  type: 'request.closed'
  threadId: string
  requestId: string
  decision: ApprovalDecision
}

export interface RuntimeTurnCompletedEvent {
  type: 'turn.completed'
  threadId: string
  costUsd?: number
  usedTokens?: number
  maxTokens?: number
  numTurns?: number
}

export interface RuntimeErrorEvent {
  type: 'error'
  threadId: string
  message: string
}

export interface RuntimeStatusEvent {
  type: 'status'
  threadId: string
  status: ProviderSessionStatus
}

export interface RuntimeSessionEvent {
  type: 'session'
  threadId: string
  sessionId: string
}

export interface RuntimeContextWindowEvent {
  type: 'context_window'
  threadId: string
  usedTokens: number
  maxTokens: number | null
}

/** Agent exited plan mode with a proposed plan (markdown) */
export interface RuntimePlanProposedEvent {
  type: 'plan.proposed'
  threadId: string
  planId: string
  planMarkdown: string
}

export interface QuestionOption {
  label: string
  description?: string
}

export interface Question {
  id: string
  header: string
  question: string
  options: QuestionOption[]
  multiSelect: boolean
}

/** Agent invoked AskUserQuestion — show UI to collect answers */
export interface RuntimeQuestionAskedEvent {
  type: 'question.asked'
  threadId: string
  requestId: string
  questions: Question[]
}

export interface RuntimeQuestionAnsweredEvent {
  type: 'question.answered'
  threadId: string
  requestId: string
  answers: string[][]
}
