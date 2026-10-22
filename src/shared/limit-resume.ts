/**
 * Auto-resume after a usage limit, for every chat: the pure rules.
 *
 * A turn that ends on a usage limit with a reset time arms one
 * `limit_resumes` row. At the reset the backend checks again (`fireChecks`)
 * and sends `limitResumeTurn()` through the approval result turn path; the
 * held queue follows. Quick repeat failures count in `streak`, and the third
 * one gives up. Stop, archive, settle, Cancel and a move disarm the row.
 *
 * The adapters use the classifiers below to mark a limited turn's end, and
 * `src/main/provider/limit-resume.ts` runs the rest on the desktop backend.
 */
import { runSlotFree, type HubRunningChild } from './hub'
import { unixSecondsToMs } from './provider-usage'

/**
 * Staged flag `limit_auto_resume`. Off until auto-resume ships on every
 * surface. `SB_LIMIT_AUTO_RESUME=1` in Switchboard's own env, or the labs
 * setting, turns it on for testing.
 */
export const LIMIT_AUTO_RESUME_ENABLED = false
export const LIMIT_AUTO_RESUME_LABS_SETTING = 'labs.limit_auto_resume'
/** The backend serves the `provider:limit-resume-*` channels and `limit-resume.changed`. */
export const LIMIT_AUTO_RESUME_CAPABILITY = 'limit_auto_resume_v1'

/** Reads one backend settings row; `getSetting` from the db module fits. */
export type SettingReader = (key: string) => string | null

export function limitAutoResumeEnabled(env: NodeJS.ProcessEnv, getSetting: SettingReader): boolean {
  return (
    LIMIT_AUTO_RESUME_ENABLED ||
    env.SB_LIMIT_AUTO_RESUME === '1' ||
    getSetting(LIMIT_AUTO_RESUME_LABS_SETTING) === 'true'
  )
}

/** Settings, Accounts: "Resume after a usage limit resets". On by default. */
export const AUTO_RESUME_AFTER_LIMIT_SETTING = 'chats.autoResumeAfterLimit'

export function autoResumeAfterLimitOn(getSetting: SettingReader): boolean {
  return getSetting(AUTO_RESUME_AFTER_LIMIT_SETTING) !== 'false'
}

/** The timer fires this long after the reset, so the window is surely open. */
export const LIMIT_RESUME_FIRE_DELAY_MS = 60_000
/** A resumed turn that fails or hits the limit again within this counts in the streak. */
export const LIMIT_RESUME_QUICK_MS = 5 * 60_000
/** The streak at which the row gives up. */
export const LIMIT_RESUME_MAX_STREAK = 3

export type LimitResumeRowState = 'armed' | 'disarmed' | 'fired' | 'gave_up'

export type LimitDisarmReason =
  | 'stop'
  | 'parent_stop'
  | 'interrupt_child'
  | 'settle'
  | 'archive'
  | 'cancel'
  | 'new_brief'
  | 'moved'
  /** A turn ended normally before the reset, so the chat is no longer limited. */
  | 'ran'
  /** The probe at the reset said the window is still closed and gave no new reset. */
  | 'no_reset'

/** The fields of a `limit_resumes` row the rules read. */
export interface LimitResumeRowView {
  state: LimitResumeRowState
  limitedTurnId: string
  resetAt: number
  requestId: string
  streak: number
  providerInstanceId: string
}

export type LimitState =
  | { kind: 'none' }
  | { kind: 'armed'; resetAt: number }
  | { kind: 'disarmed' }
  | { kind: 'gave_up' }
  | { kind: 'no_reset' }

/**
 * What the Limited row of any chat shows: "Resumes HH:MM", "Auto-resume off",
 * "Gave up after 3 tries", or "No reset time, resume by hand".
 * `limited` is whether the chat's queue is held by a usage limit now.
 */
export function limitState(limited: boolean, row: LimitResumeRowView | null): LimitState {
  if (!limited) return { kind: 'none' }
  if (row?.state === 'gave_up') return { kind: 'gave_up' }
  if (row?.state === 'armed') return { kind: 'armed', resetAt: row.resetAt }
  if (row?.state === 'disarmed') return { kind: 'disarmed' }
  return { kind: 'no_reset' }
}

/** How a turn's end was classified. Only `usage_limit` can arm. */
export type TurnLimitClass = 'usage_limit' | 'context_full' | 'other'

/**
 * What an adapter puts on `turn.completed` when the turn ended on a usage
 * limit or a full context window. No `limit` on the event means `other`.
 * `resetAt` is epoch ms.
 */
export interface TurnLimit {
  limitClass: Exclude<TurnLimitClass, 'other'>
  resetAt: number | null
}

/** Within one turn a usage limit stays: a later empty success or error does not replace it. */
export function mergeTurnLimit(prev: TurnLimit | null | undefined, next: TurnLimit | null): TurnLimit | null {
  return prev?.limitClass === 'usage_limit' ? prev : (next ?? prev ?? null)
}

/** Claude: every `rate_limit_event` rejection is a usage limit, with or without a reset. */
export function claudeRejectionLimit(resetsAtSeconds: unknown): TurnLimit {
  return { limitClass: 'usage_limit', resetAt: unixSecondsToMs(resetsAtSeconds) }
}

/** `TurnError` of the Codex app-server, as far as classification reads it. */
export interface CodexTurnErrorView {
  message?: string
  codexErrorInfo?: unknown
}

const CODEX_LIMIT_INFOS = new Set(['usageLimitExceeded', 'rateLimitExceeded'])

/**
 * Codex: a final error (no retry left) is a usage limit when the server says
 * so, when the retries ended on a 429, or when a gateway names a usage limit.
 * A full context window is `context_full`. Anything else is `other` (null).
 */
export function codexErrorLimit(error: CodexTurnErrorView | null | undefined): TurnLimit | null {
  if (!error) return null
  const info = error.codexErrorInfo
  const message = error.message ?? ''
  if (info === 'contextWindowExceeded') return { limitClass: 'context_full', resetAt: null }
  // Object variants carry the HTTP status, e.g. `responseTooManyFailedAttempts`.
  const status429 =
    typeof info === 'object' &&
    info !== null &&
    Object.values(info).some((v: { httpStatusCode?: unknown } | null) => v?.httpStatusCode === 429)
  const limited =
    (typeof info === 'string' && CODEX_LIMIT_INFOS.has(info)) ||
    status429 ||
    /\b429 Too Many Requests\b/i.test(message) ||
    /\busage limit\b/i.test(message)
  return limited ? { limitClass: 'usage_limit', resetAt: resetInMessage(message) } : null
}

/** "try again at 2026-10-21T15:40:00Z": only a full ISO time with a zone counts. */
function resetInMessage(message: string): number | null {
  const match = /try again at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/i.exec(message)
  if (!match) return null
  const ms = Date.parse(match[1])
  return Number.isFinite(ms) ? ms : null
}

export type ArmDecision =
  | { arm: true }
  | { arm: false; reason: 'not_limit' | 'no_reset' | 'reset_not_after_end' | 'setting_off' | 'disarmed' }

export function shouldArm(input: {
  limitClass: TurnLimitClass
  resetAt: number | null
  turnId: string
  turnEndedAt: number
  settingOn: boolean
  row: LimitResumeRowView | null
}): ArmDecision {
  if (input.limitClass !== 'usage_limit') return { arm: false, reason: 'not_limit' }
  if (input.resetAt === null) return { arm: false, reason: 'no_reset' }
  if (input.resetAt <= input.turnEndedAt) return { arm: false, reason: 'reset_not_after_end' }
  if (!input.settingOn) return { arm: false, reason: 'setting_off' }
  // A disarm is for the limit it was made in: Stop on this limit stays
  // stopped, but a new limit later arms again.
  if (input.row?.state === 'disarmed' && input.row.limitedTurnId === input.turnId) {
    return { arm: false, reason: 'disarmed' }
  }
  return { arm: true }
}

export type FireDecision =
  | { action: 'fire' }
  | { action: 'drop'; reason: 'stale' | 'archived' | 'settled' | 'parent_held' | 'instance_changed' | 'no_reset' }
  | { action: 'wait'; reason: 'early' | 'needs_you' | 'no_slot' | 'closed' }
  | { action: 'rearm'; resetAt: number }

/** What the fresh usage probe of the instance says at fire time. */
export type UsageProbe = { open: true } | { open: false; resetAt: number | null }

/** For a child: its own state and the run slots it competes for. */
export interface FireChildContext {
  settled: boolean
  parentHeld: boolean
  slot: HubRunningChild
  running: readonly HubRunningChild[]
  perInstance: number
  perParent: number
}

/**
 * The checks under the conversation lock before a resume turn is sent, in
 * order. `manual` is Resume now: every check except the clock.
 */
export function fireChecks(input: {
  row: LimitResumeRowView | null
  requestId: string
  now: number
  manual: boolean
  archived: boolean
  liveRequestForUser: boolean
  currentInstanceId: string
  probe: UsageProbe
  child: FireChildContext | null
}): FireDecision {
  const { row } = input
  if (!row || row.state !== 'armed' || row.requestId !== input.requestId) return { action: 'drop', reason: 'stale' }
  if (!input.manual && input.now < row.resetAt + LIMIT_RESUME_FIRE_DELAY_MS) return { action: 'wait', reason: 'early' }
  if (input.archived) return { action: 'drop', reason: 'archived' }
  if (input.child?.settled) return { action: 'drop', reason: 'settled' }
  if (input.child?.parentHeld) return { action: 'drop', reason: 'parent_held' }
  if (input.liveRequestForUser) return { action: 'wait', reason: 'needs_you' }
  if (input.currentInstanceId !== row.providerInstanceId) return { action: 'drop', reason: 'instance_changed' }
  if (!input.probe.open) {
    // Resume now says the window is still closed and leaves the row as it is.
    if (input.manual) return { action: 'wait', reason: 'closed' }
    return input.probe.resetAt === null
      ? { action: 'drop', reason: 'no_reset' }
      : { action: 'rearm', resetAt: input.probe.resetAt }
  }
  const c = input.child
  if (c && !runSlotFree(c.slot, c.running, c.perInstance, c.perParent)) return { action: 'wait', reason: 'no_slot' }
  return { action: 'fire' }
}

/**
 * The streak after a resumed turn ends. A limit or failure within 5 minutes
 * of its start counts; anything else resets it. A re-arm after a closed probe
 * counts as `limited` with no run time.
 */
export function nextStreak(input: {
  streak: number
  startedAt: number
  endedAt: number
  outcome: 'limited' | 'failed' | 'ok'
}): { streak: number; gaveUp: boolean } {
  const quick = input.endedAt - input.startedAt < LIMIT_RESUME_QUICK_MS
  if (input.outcome === 'ok' || !quick) return { streak: 0, gaveUp: false }
  const streak = input.streak + 1
  return { streak, gaveUp: streak >= LIMIT_RESUME_MAX_STREAK }
}

export const LIMIT_RESUME_OPEN = '<switchboard-limit-resume>'
export const LIMIT_RESUME_CLOSE = '</switchboard-limit-resume>'

/** The resume turn's text. Every surface's synthetic split drops the block and shows a row. */
export function limitResumeTurn(): string {
  return `${LIMIT_RESUME_OPEN}\nUsage limit reset. Continue the task where you left off.\n${LIMIT_RESUME_CLOSE}`
}

/** The stored system row a resume leaves in the chat. */
export const LIMIT_RESUME_MARKER_PREFIX = '[[sb:limit-resume]]'
export const LIMIT_RESUME_MARKER_TEXT = 'Usage limit reset. Resumed the chat.'

export function limitResumeMarker(): string {
  return `${LIMIT_RESUME_MARKER_PREFIX} ${LIMIT_RESUME_MARKER_TEXT}`
}

/** The Limited row's text. `formatTime` turns epoch ms into "15:40". */
export function limitStateText(state: LimitState, formatTime: (ms: number) => string): string | null {
  switch (state.kind) {
    case 'none':
      return null
    case 'armed':
      return `Usage limit. Resumes ${formatTime(state.resetAt)}.`
    case 'disarmed':
      return 'Usage limit. Auto-resume off.'
    case 'gave_up':
      return `Usage limit. Gave up after ${LIMIT_RESUME_MAX_STREAK} tries.`
    case 'no_reset':
      return 'Usage limit. No reset time, resume by hand.'
  }
}
