/**
 * Snooze: take a chat out of Recents until a time or an event, then bring it
 * back. The agent is never paused. The backend owns the wake (timer, events,
 * restart); these are the pure rules every client and both hosts share.
 * Kotlin port: `ChatSnooze.kt`, both run `tests/fixtures/chat-snooze-cases.json`.
 *
 * Every time here is local wall time on the device that computes it. The
 * client turns a preset into an epoch when the menu opens and sends the epoch.
 */

/**
 * Flag `chat_snooze`: on for the desktop. The phones stay staged on
 * `chat_snooze_v1` until their own release.
 */
export const CHAT_SNOOZE_ENABLED = true

export const CHAT_SNOOZE_CAPABILITY = 'chat_snooze_v1'

/** Why a snooze ended. `time`, `needs_you`, `error`, `message` and `pr` leave a Woke marker; the rest do not. */
export type WakeReason =
  | 'time'
  | 'needs_you'
  | 'error'
  | 'message'
  | 'pr'
  | 'wake_now'
  | 'undo'
  | 'turn'
  | 'settle'
  | 'archive'

/** The wakes counted in analytics (`chat_woke`). */
export const TRACKED_WAKE_REASONS = ['time', 'needs_you', 'error', 'message', 'pr', 'wake_now'] as const

/** The reasons that show `Woke` on the row until the chat is opened. */
export const MARKED_WAKE_REASONS: readonly WakeReason[] = ['time', 'needs_you', 'error', 'message', 'pr']

export interface SnoozeState {
  /** Epoch ms; null for a PR-only snooze or when not snoozed. */
  snoozedUntil: number | null
  /** Set while snoozed, null otherwise. The only test of "is snoozed". */
  snoozedAt: number | null
  /** The PR whose events wake it, as `prKey` (`github:owner/repo#512`). */
  snoozePr: string | null
  /** Bumped by every change to the fields above, so a stale timer or Undo can be refused. */
  snoozeRev: number
  /** Set by a marked wake, cleared when the chat is opened, a turn is sent, it is settled or archived. */
  wokeAt: number | null
  wokeReason: WakeReason | null
}

export const NOT_SNOOZED: SnoozeState = {
  snoozedUntil: null,
  snoozedAt: null,
  snoozePr: null,
  snoozeRev: 0,
  wokeAt: null,
  wokeReason: null,
}

export function isSnoozed(s: Pick<SnoozeState, 'snoozedAt'>): boolean {
  return s.snoozedAt != null
}

/** The Woke marker shows. Never on a snoozed chat. */
export function isWoke(s: Pick<SnoozeState, 'snoozedAt' | 'wokeAt'>): boolean {
  return s.snoozedAt == null && s.wokeAt != null
}

/**
 * What happened to a chat, as the backend sees it.
 * - `message`: `from: 'person'` is a message a person sent into the chat from
 *   elsewhere (Send to). Messages from agents, sub-task results and notices
 *   are `agent` and never wake. `at` is when the send started; one at or
 *   before the snooze was sent before the user snoozed.
 * - `error`: `at` is when the failure happened; one at or before the snooze
 *   was already in view when the user snoozed.
 * - `turn_completed`: a normal end. It never wakes: the result waits under the snooze.
 */
export type InboxEvent =
  | { kind: 'time'; now: number }
  | { kind: 'needs_you' }
  | { kind: 'error'; at: number }
  | { kind: 'message'; from: 'person' | 'agent'; at: number }
  | { kind: 'pr'; pr: string }
  | { kind: 'turn_completed' }

export function shouldWakeOn(event: InboxEvent, s: SnoozeState): WakeReason | null {
  if (!isSnoozed(s)) return null
  switch (event.kind) {
    case 'time':
      return s.snoozedUntil != null && event.now >= s.snoozedUntil ? 'time' : null
    case 'needs_you':
      return 'needs_you'
    case 'error':
      return event.at > (s.snoozedAt ?? 0) ? 'error' : null
    case 'message':
      return event.from === 'person' && event.at > (s.snoozedAt ?? 0) ? 'message' : null
    case 'pr':
      return s.snoozePr === event.pr ? 'pr' : null
    case 'turn_completed':
      return null
  }
}

// ---------------------------------------------------------------- presets

/**
 * A menu item. `duration` counts from the click; the other two are a clock
 * time, frozen at the instant the menu showed.
 * - `duration`: now plus `minutes`, rounded up to the next :00 or :30 when an
 *   hour or more. One shorter than a day shows only while it ends today before 21:00.
 * - `time`: `hour:minute` today (`dayOffset` 0) or tomorrow (1). Today's shows
 *   only while it is more than an hour away.
 * - `weekday`: the next such weekday (0 Sunday) after today, at `hour:minute`.
 */
export type SnoozePresetSpec =
  | { label: string; kind: 'duration'; minutes: number }
  | { label: string; kind: 'time'; dayOffset: 0 | 1; hour: number; minute: number }
  | { label: string; kind: 'weekday'; weekday: number; hour: number; minute: number }

export const MAX_SNOOZE_PRESETS = 8

export const DEFAULT_SNOOZE_PRESETS: readonly SnoozePresetSpec[] = [
  { label: 'Later today', kind: 'duration', minutes: 180 },
  { label: 'Tonight', kind: 'time', dayOffset: 0, hour: 20, minute: 0 },
  { label: 'Tomorrow morning', kind: 'time', dayOffset: 1, hour: 9, minute: 0 },
  { label: 'Next week', kind: 'weekday', weekday: 1, hour: 9, minute: 0 },
]

/** What a snooze was picked from, for analytics: a default preset, the PR wake, the dialog, or a preset of the user's own. */
export const SNOOZE_PRESET_KINDS = [
  'later_today',
  'tonight',
  'tomorrow_morning',
  'next_week',
  'pr',
  'custom',
  'preset',
] as const
export type SnoozePresetKind = (typeof SNOOZE_PRESET_KINDS)[number]

/** Where a snooze was asked for, for analytics. */
export const SNOOZE_SURFACES = ['row', 'context_menu', 'palette', 'composer', 'phone'] as const
export type SnoozeSurface = (typeof SNOOZE_SURFACES)[number]

const DEFAULT_PRESET_KINDS: readonly SnoozePresetKind[] = ['later_today', 'tonight', 'tomorrow_morning', 'next_week']

/** The analytics kind of a menu preset: a default one by name, any other `preset`. */
export function presetKindOf(spec: SnoozePresetSpec): SnoozePresetKind {
  const i = DEFAULT_SNOOZE_PRESETS.findIndex((d) => JSON.stringify(d) === JSON.stringify(spec))
  return i >= 0 ? DEFAULT_PRESET_KINDS[i] : 'preset'
}

/** The cutoff of a sub-day duration: it must end before this hour, today. */
const DURATION_LAST_HOUR = 21

export interface PresetOption {
  label: string
  /** Epoch ms shown in the menu. For a duration it is recomputed on the click (`pickPreset`). */
  at: number
  spec: SnoozePresetSpec
}

/** Local midnight `days` calendar days from `now` (not 24 h steps, so DST days count once). */
function localDay(now: Date, days: number, hour: number, minute: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, minute, 0, 0)
}

function durationEnd(now: Date, minutes: number): Date {
  const end = new Date(now.getTime() + minutes * 60_000)
  const unit = minutes >= 60 ? 30 : 1
  const rest = (end.getMinutes() % unit) * 60_000 + end.getSeconds() * 1000 + end.getMilliseconds()
  return rest === 0 ? end : new Date(end.getTime() - rest + unit * 60_000)
}

function presetTime(spec: SnoozePresetSpec, now: Date): Date | null {
  switch (spec.kind) {
    case 'duration': {
      const end = durationEnd(now, spec.minutes)
      if (spec.minutes < 24 * 60) {
        const sameDay = end.getDate() === now.getDate() && end.getMonth() === now.getMonth()
        if (!sameDay || end.getHours() >= DURATION_LAST_HOUR) return null
      }
      return end
    }
    case 'time': {
      const at = localDay(now, spec.dayOffset, spec.hour, spec.minute)
      if (spec.dayOffset === 0 && at.getTime() - now.getTime() <= 60 * 60_000) return null
      return at
    }
    case 'weekday': {
      const ahead = (spec.weekday - now.getDay() + 7) % 7 || 7
      return localDay(now, ahead, spec.hour, spec.minute)
    }
  }
}

/** The menu: soonest first, one item per minute (the first spec wins a tie). */
export function resolvePresets(now: Date, specs: readonly SnoozePresetSpec[] = DEFAULT_SNOOZE_PRESETS): PresetOption[] {
  const seen = new Set<number>()
  const out: PresetOption[] = []
  for (const spec of specs) {
    const at = presetTime(spec, now)
    if (!at) continue
    const minute = Math.floor(at.getTime() / 60_000)
    if (seen.has(minute)) continue
    seen.add(minute)
    out.push({ label: spec.label, at: at.getTime(), spec })
  }
  return out.sort((a, b) => a.at - b.at)
}

/**
 * The epoch a click sends. A duration counts from the click; a clock time
 * keeps the instant the menu showed, and is refused once that has passed.
 */
export function pickPreset(
  option: PresetOption,
  now: number,
): { ok: true; at: number } | { ok: false; reason: 'past' } {
  if (option.spec.kind === 'duration')
    return { ok: true, at: durationEnd(new Date(now), option.spec.minutes).getTime() }
  return option.at > now ? { ok: true, at: option.at } : { ok: false, reason: 'past' }
}

/** A preset as stored (settings `chats.snoozePresets`), or null when it is not one. */
export function parsePresetSpec(raw: unknown): SnoozePresetSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const label = typeof r.label === 'string' ? r.label.trim() : ''
  if (!label || label.length > 40) return null
  const int = (v: unknown, min: number, max: number): number | null =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null
  if (r.kind === 'duration') {
    const minutes = int(r.minutes, 5, 365 * 24 * 60)
    return minutes === null ? null : { label, kind: 'duration', minutes }
  }
  const hour = int(r.hour, 0, 23)
  const minute = int(r.minute, 0, 59)
  if (hour === null || minute === null) return null
  if (r.kind === 'time') {
    const dayOffset = int(r.dayOffset, 0, 1)
    return dayOffset === null ? null : { label, kind: 'time', dayOffset: dayOffset as 0 | 1, hour, minute }
  }
  if (r.kind === 'weekday') {
    const weekday = int(r.weekday, 0, 6)
    return weekday === null ? null : { label, kind: 'weekday', weekday, hour, minute }
  }
  return null
}

/** The stored list, or the defaults when it is missing or holds nothing usable. */
export function parsePresetList(raw: unknown): SnoozePresetSpec[] {
  if (!Array.isArray(raw)) return [...DEFAULT_SNOOZE_PRESETS]
  const specs = raw.map(parsePresetSpec).filter((s): s is SnoozePresetSpec => s !== null)
  return specs.length > 0 ? specs.slice(0, MAX_SNOOZE_PRESETS) : [...DEFAULT_SNOOZE_PRESETS]
}

// ---------------------------------------------------------------- custom time

export const MAX_SNOOZE_MS = 365 * 24 * 60 * 60_000
/** The backend accepts a wake this far in the past (clock skew, a slow click). */
export const SNOOZE_PAST_GRACE_MS = 60_000

/**
 * A local date and clock time as an epoch, or null when that wall time does
 * not exist: a rolled-over date (31 April) or a time skipped by a DST change.
 * A time that occurs twice (the autumn change) takes its first occurrence.
 * `month` is 1 to 12.
 */
export function localWallTime(year: number, month: number, day: number, hour: number, minute: number): number | null {
  const d = new Date(year, month - 1, day, hour, minute, 0, 0)
  const same =
    d.getFullYear() === year &&
    d.getMonth() === month - 1 &&
    d.getDate() === day &&
    d.getHours() === hour &&
    d.getMinutes() === minute
  return same ? d.getTime() : null
}

/** `H:MM` or `HH:MM`, 00:00 to 23:59. */
export function parseClock(text: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  return hour <= 23 && minute <= 59 ? { hour, minute } : null
}

export type WakeCheck = 'ok' | 'past' | 'too_far' | 'invalid'

/** The client's check of a custom date and time. */
export function validateCustomWake(
  date: { year: number; month: number; day: number },
  clock: string,
  now: number,
): { result: WakeCheck; at: number | null } {
  const c = parseClock(clock)
  if (!c) return { result: 'invalid', at: null }
  const at = localWallTime(date.year, date.month, date.day, c.hour, c.minute)
  if (at === null) return { result: 'invalid', at: null }
  if (at <= now) return { result: 'past', at }
  if (at - now > MAX_SNOOZE_MS) return { result: 'too_far', at }
  return { result: 'ok', at }
}

/** The backend's check of a wake time it is sent. */
export function checkWakeTime(at: number, now: number): 'ok' | 'past' | 'too_far' {
  if (!Number.isFinite(at) || at < now - SNOOZE_PAST_GRACE_MS) return 'past'
  if (at - now > MAX_SNOOZE_MS) return 'too_far'
  return 'ok'
}

// ---------------------------------------------------------------- labels

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** `512` from `github:owner/repo#512`. */
export function prNumberOf(pr: string): string {
  const i = pr.lastIndexOf('#')
  return i >= 0 ? pr.slice(i + 1) : pr
}

/** The time cell of a snoozed row: `20:00` today, `Tue 09:00` within a week, `12 Nov` after, `PR #512` for a PR wake. */
export function wakeLabel(until: number | null, pr: string | null, now: Date): string {
  if (until == null) return pr ? `PR #${prNumberOf(pr)}` : ''
  const at = new Date(until)
  const days = Math.round((localDay(at, 0, 0, 0).getTime() - localDay(now, 0, 0, 0).getTime()) / (24 * 60 * 60_000))
  if (days <= 0) return hhmm(at)
  if (days < 7) return `${WEEKDAYS[at.getDay()]} ${hhmm(at)}`
  return `${at.getDate()} ${MONTHS[at.getMonth()]}`
}

/** `Tue 4 Nov at 09:00`, for the custom dialog and the undo notice. */
export function wakeSentence(until: number): string {
  const at = new Date(until)
  return `${WEEKDAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]} at ${hhmm(at)}`
}

/** The status line of a woken row, or null to keep the live one (a Needs you row keeps its own). */
export function wokeLine(reason: WakeReason | null, prSummary?: string | null): string | null {
  switch (reason) {
    case 'time':
      return 'Snooze ended'
    case 'message':
      return 'New message'
    case 'pr':
      return prSummary ?? 'Pull request changed'
    default:
      return null
  }
}

// ---------------------------------------------------------------- PR wakes

/** What a PR read says, for the PR wake. Built from `PrDetail` by the backend. */
export interface PrReading {
  number: number
  state: 'open' | 'merged' | 'closed'
  /** The host's last update time, epoch ms: a read older than the mark is a stale cache. */
  updatedAt: number | null
  headSha: string | null
  checksFailed: boolean
  /** The newest "requested changes" review, epoch ms, or null. */
  changesRequestedAt: number | null
}

/**
 * The PR as it was when the snooze started (`snooze_pr_mark`). Its times are
 * the host's, so a later read compares the host's clock with itself.
 */
export type PrMark = Omit<PrReading, 'number'>

export function prMarkOf({ number: _number, ...mark }: PrReading): PrMark {
  return mark
}

/** The stored mark, or null when it is missing or not a mark. */
export function parsePrMark(raw: string | null): PrMark | null {
  if (!raw) return null
  let m: Partial<PrMark>
  try {
    m = JSON.parse(raw) as Partial<PrMark>
  } catch {
    return null
  }
  if (m.state !== 'open' && m.state !== 'merged' && m.state !== 'closed') return null
  const time = (v: unknown) => (typeof v === 'number' ? v : null)
  return {
    state: m.state,
    updatedAt: time(m.updatedAt),
    headSha: m.headSha ?? null,
    checksFailed: m.checksFailed === true,
    changesRequestedAt: time(m.changesRequestedAt),
  }
}

/**
 * The status line of a PR wake, or null when the PR gives no reason to wake.
 * Only three events wake, each only forward from the mark: the PR merged; a
 * review requested changes after the newest one at the mark; the checks failed
 * on a head that had not failed at the mark (a new push that fails counts).
 * Comments, approvals and pushes alone do not wake. A read older than the mark
 * (a stale cache) wakes nothing, so what the mark acknowledged never wakes.
 */
export function prWakeSummary(mark: PrMark, now: PrReading): string | null {
  if (mark.updatedAt !== null && now.updatedAt !== null && now.updatedAt < mark.updatedAt) return null
  if (now.state === 'merged' && mark.state !== 'merged') return `PR #${now.number} merged`
  if (now.changesRequestedAt !== null && now.changesRequestedAt > (mark.changesRequestedAt ?? -Infinity))
    return `PR #${now.number}: changes requested`
  if (now.checksFailed && (!mark.checksFailed || now.headSha !== mark.headSha))
    return `PR #${now.number}: checks failed`
  return null
}

// ---------------------------------------------------------------- wire

export interface SnoozeRequest {
  /** Epoch ms, or null for a PR-only snooze. */
  until: number | null
  /** `prKey` of a PR the chat links, to wake on its next event; any other is refused (`pr_unlinked`). */
  pr?: string | null
  /** Undo of a wake: refused unless the chat is still at this revision. */
  expectRev?: number
  /** For analytics only; an Undo sends neither. */
  preset?: SnoozePresetKind
  surface?: SnoozeSurface
}

export type SnoozeRefusal =
  | 'needs_you'
  | 'past'
  | 'too_far'
  | 'pr_closed'
  | 'pr_unlinked'
  | 'pr_unreadable'
  | 'no_row'
  | 'stale'
  | 'empty'

export type SnoozeResult =
  | { ok: true; until: number | null; pr: string | null; rev: number }
  | { ok: false; reason: SnoozeRefusal }

/** Broadcast on `app:conversation-snoozed` after every change, from any client or the timer. */
export interface ConversationSnoozedEvent extends SnoozeState {
  conversationId: string
  title?: string
  /** The PR event that woke it, as a status line. */
  prSummary?: string
}
