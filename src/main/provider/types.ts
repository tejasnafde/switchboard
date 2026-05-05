/**
 * Provider abstraction layer — internal (main-process) adapter interface.
 *
 * The wire-format event types (RuntimeEvent union, Question, etc.) live in
 * `src/shared/provider-events.ts` so both preload and renderer can type their
 * IPC boundary against the same discriminated union. This file re-exports
 * those for adapter-internal convenience and adds main-only types.
 */

import type { Effect } from 'effect'

export type {
  ProviderKind,
  RuntimeMode,
  ProviderSessionStatus,
  ApprovalDecision,
  RuntimeEvent,
  RuntimeContentEvent,
  RuntimeToolStartedEvent,
  RuntimeToolCompletedEvent,
  RuntimeToolDeniedEvent,
  RuntimeRequestOpenedEvent,
  RuntimeRequestClosedEvent,
  RuntimeTurnCompletedEvent,
  RuntimeErrorEvent,
  RuntimeStatusEvent,
  RuntimeSessionEvent,
  RuntimeContextWindowEvent,
  RuntimeModelVariantsEvent,
  RuntimePlanProposedEvent,
  RuntimeQuestionAskedEvent,
  RuntimeQuestionAnsweredEvent,
  Question,
  QuestionOption,
} from '@shared/provider-events'

import type {
  ProviderKind,
  RuntimeMode,
  ProviderSessionStatus,
  ApprovalDecision,
  RuntimeEvent,
} from '@shared/provider-events'

// ─── Session Management ────────────────────────────────────────

export interface SessionStartOpts {
  threadId: string
  provider: ProviderKind
  cwd: string
  model?: string
  runtimeMode?: RuntimeMode
  resumeSessionId?: string
  /** Codex-only: reasoning effort tier (low/medium/high). */
  reasoningEffort?: 'low' | 'medium' | 'high'
  /** provider_instances row id; falls back to `<agent-type>-default`. */
  instanceId?: string
  /** Resolved env overlay (registry-populated; do not set from renderer). */
  resolvedEnv?: Record<string, string>
  /** Per-instance config dir → CLAUDE_CONFIG_DIR (claude) or CODEX_HOME (codex). */
  resolvedOauthDir?: string | null
  /**
   * All known config dirs for this agent kind (every enabled instance's
   * resolved oauth_dir, plus the default). Used by adapters to find a
   * resumeable JSONL across profiles when in-memory rotation tracking is
   * cold (e.g. after an app restart).
   */
  candidateOauthDirs?: string[]
}

export interface ProviderSession {
  threadId: string
  provider: ProviderKind
  status: ProviderSessionStatus
  model?: string
  runtimeMode: RuntimeMode
  cwd: string
  sessionId?: string
  createdAt: number
  /** Codex-only: reasoning effort tier (low/medium/high). */
  reasoningEffort?: 'low' | 'medium' | 'high'
  /** ID of the provider_instances row this session resolved to. */
  instanceId?: string
}

// ─── Provider Adapter Interface ────────────────────────────────

export interface ProviderAdapter {
  readonly provider: ProviderKind

  /**
   * Start a new session. The adapter should begin listening for events
   * and emit RuntimeEvents via the onEvent callback.
   */
  startSession(
    opts: SessionStartOpts,
    onEvent: (event: RuntimeEvent) => void,
  ): Promise<ProviderSession>

  /**
   * Send a user message to an active session.
   * The adapter should stream responses as RuntimeEvents.
   */
  sendTurn(
    threadId: string,
    message: string,
    runtimeMode?: RuntimeMode,
    images?: Array<{ url: string; mimeType?: string }>,
  ): Promise<void>

  /**
   * Interrupt the current turn (cancel in-progress work).
   */
  interruptTurn(threadId: string): Promise<void>

  /**
   * Respond to an approval request (tool permission prompt).
   */
  respondToRequest(
    threadId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void>

  /**
   * Stop and clean up a session.
   */
  stopSession(threadId: string): Promise<void>

  /**
   * Change the runtime/permission mode of a running session.
   * Applies immediately if the adapter supports mid-turn updates; otherwise
   * updates the stored mode so the next turn uses the new value.
   */
  setRuntimeMode(threadId: string, mode: RuntimeMode): Promise<void>

  /**
   * Update the model used for subsequent turns. Needed because the renderer
   * allows switching models mid-conversation; without this, the adapter
   * keeps using whatever was set at startSession. Claude/Codex can no-op if
   * they don't support mid-session model changes.
   */
  setModel?(threadId: string, model: string): Promise<void>

  /**
   * Answer an AskUserQuestion request (unblocks the agent).
   * `answers` is an array parallel to `questions`: each inner array is the
   * set of selected labels for that question (single-select = length 1).
   */
  answerQuestion?(threadId: string, requestId: string, answers: string[][]): Promise<void>

  /**
   * Check if this provider is available on the system.
   */
  isAvailable(): Promise<boolean>

  /**
   * List the agent-defined slash commands / skills available for this
   * session (Claude SDK's `init.commands`, Codex's `skills/list`, etc.).
   * Returns `[]` when the provider has none or hasn't initialized yet.
   *
   * Optional — providers without a skill registry (OpenCode) can omit it.
   */
  listSkills?(threadId: string): Promise<import('@shared/types').ProviderSkill[]>
}

// Re-export Effect for internal adapter use (avoids extra imports elsewhere)
export type { Effect }
