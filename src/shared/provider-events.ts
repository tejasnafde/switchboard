/**
 * Provider runtime events - the wire format for main → renderer provider updates.
 *
 * Lives in `shared/` so both the preload (main-scope) and renderer can type
 * `window.api.provider.onEvent` against the same discriminated union. Keeping
 * these types out of `src/main/provider/types.ts` (main-only) prevents the
 * "as any" casts that used to flood ChatPanel.
 *
 * Adapter-specific types (ProviderAdapter interface, SessionStartOpts, etc.)
 * stay in `src/main/provider/types.ts`; only the wire events are shared.
 */

import type { OverageScope } from './claude-rate-limit'
import type { PeerMessageInitiator } from './peer-messaging'

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

/**
 * The session's agent wrote into a git worktree other than the session's
 * folder. Surfaced as a follow affordance: accepting swaps the conversation's
 * worktree pointer, which the branch chip, IDE pane, terminals, and diff
 * review all derive from. Detection feeds on the session's OWN tool stream,
 * so parallel agents in sibling worktrees never cross-contaminate.
 */
export interface RuntimeWorktreeDriftEvent {
  type: 'worktree.drift'
  threadId: string
  worktreePath: string
  branch: string
}

/**
 * A turn was refused because the model billed to extra usage and that pool is
 * unavailable. Separate from `error` so the renderer can remember the
 * (instance, model) pair and warn before the next send.
 */
export interface RuntimeSpendBlockedEvent {
  type: 'spend.blocked'
  threadId: string
  /** Provider instance in use, so a sibling profile is not tarred with this. */
  instanceId: string | null
  /** Resolved model id, e.g. `claude-fable-5`. */
  model: string | null
  /** Raw provider reason, e.g. `org_level_disabled_until`. */
  reason: string | null
  /** Classified scope, so the composer warning cannot contradict this error. */
  scope: OverageScope
  /** Epoch ms when the credit pool resets. null when unknown. */
  resetsAtMs: number | null
}

/**
 * A client marked a thread read. Read state lives on the backend, so this is
 * how the OTHER clients learn to drop their badge - each one counting unread on
 * its own is what let the phone and the Mac disagree.
 */
export interface RuntimeThreadReadEvent {
  type: 'thread.read'
  threadId: string
  at: number
}

/**
 * A message was handed from one session to another on this backend.
 *
 * Emitted twice per delivery, once per thread, so both transcripts record it
 * without either client having to see the other's events. The sending side
 * renders a compact marker; the receiving side renders the injected turn.
 *
 * `text` is the user's own words. The receiver rebuilds the wire body with
 * `wrapPeerMessage` from shared/peer-messaging rather than the event carrying
 * the wrapper a second time.
 */
export interface RuntimePeerMessageEvent {
  type: 'peer.message'
  threadId: string
  direction: 'sent' | 'received'
  /**
   * Who decided to send. The sending transcript says so, because "the agent
   * messaged another chat on its own" is a different event to the user typing
   * `/send-to` and reads as a bug if the two look alike.
   */
  initiator: PeerMessageInitiator
  /** Content-addressed id, identical on both sides of one delivery. */
  messageId: string
  /** The thread at the other end of the delivery. */
  peerThreadId: string
  /** That thread's title, so a client can label it without its own lookup. */
  peerLabel: string
  text: string
  at: number
}

/** One entry of an agent's own progress checklist. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export interface TodoItem {
  text: string
  status: TodoStatus
}

/**
 * The agent's progress checklist changed (Codex `update_plan`, and Claude's
 * TodoWrite if it is wired later).
 *
 * Distinct from `plan.proposed`, which asks the user to approve a plan before
 * work starts. A todo list needs no decision, and it is replaced in place
 * rather than appended, because it updates many times per turn.
 */
export interface RuntimeTodoUpdatedEvent {
  type: 'todo.updated'
  threadId: string
  /** Stable per list, so an update replaces its predecessor. */
  todoId: string
  items: TodoItem[]
}

export type RuntimeEvent = (
  | RuntimeContentEvent
  | RuntimeUserMessageEvent
  | RuntimeToolStartedEvent
  | RuntimeToolCompletedEvent
  | RuntimeToolDeniedEvent
  | RuntimeRequestOpenedEvent
  | RuntimeRequestClosedEvent
  | RuntimeTurnCompletedEvent
  | RuntimeTurnRetryingEvent
  | RuntimeErrorEvent
  | RuntimeStatusEvent
  | RuntimeSessionEvent
  | RuntimeSessionProviderEvent
  | RuntimeContextWindowEvent
  | RuntimeModelVariantsEvent
  | RuntimePlanProposedEvent
  | RuntimeQuestionAskedEvent
  | RuntimeQuestionAnsweredEvent
  | RuntimeFileEditedEvent
  | RuntimeWorktreeDriftEvent
  | RuntimeSpendBlockedEvent
  | RuntimeThreadReadEvent
  | RuntimePeerMessageEvent
  | RuntimeTodoUpdatedEvent
) & {
  /** Which machine emitted this event ('local' or a remote's id). Stamped by
   *  preload's provider.onEvent, not the adapter - used to reject cross-machine
   *  bleed when two machines emit the same threadId. */
  machineId?: string
}

/**
 * The message id a `user.message` echo will carry.
 *
 * A client appends its own turn optimistically and the backend then broadcasts
 * it to everyone. Using this id for BOTH means the echo collapses onto the
 * optimistic message by id, in whatever store the client keeps. The alternative
 * - a set of "origins I sent" consulted on arrival - has to survive a remount,
 * a hot reload and a second panel claiming the event, and did not.
 */
export function echoMessageId(origin: string): string {
  return `remote_${origin}`
}

export interface RuntimeContentEvent {
  type: 'content'
  threadId: string
  messageId: string
  /** An increment when `append` is set, otherwise the whole message body. */
  text: string
  /**
   * True when `text` extends the message rather than replacing it.
   *
   * Adapters set this wherever their provider hands them a delta, which is the
   * common case. Emitting the accumulated body every token cost O(n^2) bytes,
   * invisible over local IPC and ruinous over a phone's radio.
   *
   * Absent means a full snapshot, which is what non-streaming providers and
   * one-shot notices produce. Fold with `applyContentText` in shared/
   * content-stream rather than deciding per call site.
   */
  append?: boolean
  streamKind: 'assistant' | 'reasoning' | 'plan'
}

/**
 * A user turn was submitted. The adapter never emits this - the registry does,
 * on send-turn, because the typed text otherwise exists only in the client that
 * typed it. Without it a phone's message never reaches the desktop, even though
 * the agent's reply does.
 *
 * `origin` is a client-generated id echoed back so the sender can skip its own
 * message, which it already appended optimistically.
 */
export interface RuntimeUserMessageEvent {
  type: 'user.message'
  threadId: string
  text: string
  origin?: string
  at: number
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
  turnId?: string
  costUsd?: number
  usedTokens?: number
  maxTokens?: number
  numTurns?: number
  /**
   * Wall-clock duration of the turn in milliseconds, measured from when the
   * adapter accepted the user message to when the agent finished responding.
   * Optional - adapters that can't measure (e.g. legacy paths) omit it.
   * Rendered by MessageBubble as "Worked for X.Xs" Cursor-style.
   */
  durationMs?: number
}

export interface RuntimeTurnRetryingEvent {
  type: 'turn.retrying'
  threadId: string
  turnId: string
  message: string
}

export interface RuntimeErrorEvent {
  type: 'error'
  threadId: string
  message: string
  turnId?: string
}

export interface RuntimeStatusEvent {
  type: 'status'
  threadId: string
  status: ProviderSessionStatus
}

/**
 * Which provider and credential profile a thread is now running on.
 *
 * Published by the registry whenever a session starts, so EVERY connected
 * client agrees. Without it a rotation done on one client leaves the others
 * labelling the thread with the profile it used to run on.
 */
export interface RuntimeSessionProviderEvent {
  type: 'session.provider'
  threadId: string
  provider: ProviderKind
  instanceId: string | null
  /** Display name, so a client can label the chip without its own lookup. */
  instanceName: string | null
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
  /**
   * Model the session RESOLVED to, e.g. `claude-fable-5`. Lets the UI name the
   * real model when the user pinned nothing.
   */
  model?: string
  /** Cumulative session cost in USD, when the agent reports it. ACP's
   * `usage_update` carries this; legacy adapters omit it. */
  costUsd?: number
}

/**
 * Emitted when the agent reports an updated set of model variants for the
 * currently selected model (ACP's `_meta.opencode.availableVariants`).
 * Variants like 'low' / 'medium' / 'high' / 'max' map to thinking-budget
 * tiers - not all models support them, hence the dynamic shape.
 */
export interface RuntimeModelVariantsEvent {
  type: 'model.variants'
  threadId: string
  modelId: string
  /** Empty array when the model has no variants. */
  availableVariants: string[]
  /** The variant currently in effect (empty string if base model). */
  currentVariant: string
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

/** Agent invoked AskUserQuestion - show UI to collect answers */
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

/**
 * Emitted once per file changed during a turn, derived from a git checkpoint
 * diff (start-of-turn snapshot vs end-of-turn working tree). Provider-agnostic
 * - git is the source of truth, so this fires identically for Claude / Codex /
 * OpenCode regardless of how each surfaces its edits. Drives the Cursor-style
 * in-chat diff card with per-hunk accept/reject.
 */
export interface RuntimeFileEditedEvent {
  type: 'file.edited'
  threadId: string
  /** Turn identity (the adapter's turnStartedAt timestamp, stringified). */
  turnId: string
  /** Stable id for coalescing re-edits of the same file within a turn. */
  fileEditId: string
  /** Absolute repo root the edit is relative to - renderer needs it for write-back. */
  repoRoot: string
  relPath: string
  changeKind: 'add' | 'modify' | 'delete'
  /** File content at the start-of-turn checkpoint. Empty for an added file. */
  oldContent: string
  /** File content at end of turn. Empty for a deleted file. */
  newContent: string
}
