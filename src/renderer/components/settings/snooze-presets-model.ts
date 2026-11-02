/**
 * Settings > General > Snooze presets, as pure rules: a row's draft, its
 * checks (the limits of `parsePresetSpec`), what the row and the status line
 * say, and the menu the saved list gives now. A draft is editor state only;
 * the backend stores `SnoozePresetSpec`s.
 */
import { MAX_SNOOZE_PRESETS, formatClock, parseClock, presetTiming, type SnoozePresetSpec } from '@shared/chat-snooze'

export type PresetKind = SnoozePresetSpec['kind']
export type DurationUnit = 'minutes' | 'hours' | 'days'

export const KIND_OPTIONS: ReadonlyArray<{ value: PresetKind; label: string }> = [
  { value: 'time', label: 'Time of day' },
  { value: 'weekday', label: 'Weekday and time' },
  { value: 'duration', label: 'Duration' },
]
export const DAY_OPTIONS: ReadonlyArray<{ value: '0' | '1'; label: string }> = [
  { value: '0', label: 'Today' },
  { value: '1', label: 'Tomorrow' },
]
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const FULL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** Monday first; the name of each is the full day. */
export const WEEKDAY_OPTIONS: ReadonlyArray<{ value: string; label: string; name: string }> = [1, 2, 3, 4, 5, 6, 0].map(
  (d) => ({ value: String(d), label: SHORT_DAYS[d], name: FULL_DAYS[d] }),
)
export const UNIT_OPTIONS: ReadonlyArray<{ value: DurationUnit; label: string }> = [
  { value: 'minutes', label: 'Minutes' },
  { value: 'hours', label: 'Hours' },
  { value: 'days', label: 'Days' },
]
const UNIT_MINUTES: Record<DurationUnit, number> = { minutes: 1, hours: 60, days: 1440 }

const LABEL_MAX = 40
const MIN_MINUTES = 5
const MAX_MINUTES = 365 * 1440

export const LIMIT_REASON = `You have ${MAX_SNOOZE_PRESETS} presets, the most the menu holds. Remove one to add another.`
export const LAST_ROW_REASON =
  'The menu needs at least one preset, so you cannot remove the last one. Change it, or reset to the defaults.'

export type DraftField = 'label' | 'time' | 'amount'

export interface PresetDraft {
  id: string
  label: string
  kind: PresetKind
  dayOffset: 0 | 1
  /** What the time field holds, `HH:MM` once valid and blurred. */
  time: string
  weekday: number
  amount: string
  unit: DurationUnit
  /** Fields that lost focus at least once: their errors show. */
  touched: Partial<Record<DraftField, true>>
  /** A text field changed and has not lost focus yet. */
  dirty: boolean
  /** The last saved spec of this row, which the menu keeps while the draft is not valid. */
  saved: SnoozePresetSpec | null
}

/** An added row: Time of day, Tomorrow 09:00, no label yet. */
export function blankDraft(id: string): PresetDraft {
  return {
    id,
    label: '',
    kind: 'time',
    dayOffset: 1,
    time: '09:00',
    weekday: 1,
    amount: '1',
    unit: 'hours',
    touched: {},
    dirty: false,
    saved: null,
  }
}

/** The unit is the largest one that divides the minutes. */
export function draftFromSpec(id: string, spec: SnoozePresetSpec): PresetDraft {
  const draft: PresetDraft = { ...blankDraft(id), label: spec.label, kind: spec.kind, saved: spec }
  if (spec.kind === 'duration') {
    const unit: DurationUnit = spec.minutes % 1440 === 0 ? 'days' : spec.minutes % 60 === 0 ? 'hours' : 'minutes'
    return { ...draft, unit, amount: String(spec.minutes / UNIT_MINUTES[unit]) }
  }
  const time = formatClock(spec)
  return spec.kind === 'time'
    ? { ...draft, time, dayOffset: spec.dayOffset }
    : { ...draft, time, weekday: spec.weekday }
}

export interface DraftCheck {
  errors: Partial<Record<DraftField, string>>
  spec: SnoozePresetSpec | null
}

export function checkDraft(d: PresetDraft): DraftCheck {
  const errors: DraftCheck['errors'] = {}
  const label = d.label.trim()
  if (!label) errors.label = 'Enter a label.'
  else if (label.length > LABEL_MAX) errors.label = `Use ${LABEL_MAX} characters or fewer (now ${label.length}).`
  let minutes = 0
  let clock: { hour: number; minute: number } | null = null
  if (d.kind === 'duration') {
    const amount = d.amount.trim()
    if (!/^\d+$/.test(amount)) errors.amount = 'Enter a whole number, for example 3.'
    else {
      minutes = Number(amount) * UNIT_MINUTES[d.unit]
      if (minutes < MIN_MINUTES || minutes > MAX_MINUTES) errors.amount = 'Use a duration from 5 minutes to 365 days.'
    }
  } else {
    clock = parseClock(d.time)
    if (!clock) errors.time = 'Enter a time from 00:00 to 23:59, for example 07:30.'
  }
  if (Object.keys(errors).length > 0) return { errors, spec: null }
  if (d.kind === 'duration') return { errors, spec: { label, kind: 'duration', minutes } }
  const { hour, minute } = clock!
  if (d.kind === 'time') return { errors, spec: { label, kind: 'time', dayOffset: d.dayOffset, hour, minute } }
  return { errors, spec: { label, kind: 'weekday', weekday: d.weekday, hour, minute } }
}

/** The row's name in its accessible names: its label, or `preset N`. */
export function draftName(d: PresetDraft, index: number): string {
  return d.label.trim() || `preset ${index + 1}`
}

/** What a blur leaves in the field: a trimmed label, a valid time as `HH:MM`. */
export function normalizeField(d: PresetDraft, field: DraftField): PresetDraft {
  if (field === 'label') return { ...d, label: d.label.trim() }
  if (field === 'time') {
    const clock = parseClock(d.time)
    return clock ? { ...d, time: formatClock(clock) } : d
  }
  return { ...d, amount: d.amount.trim() }
}

/** Each row's valid spec, else the one it last saved; a row never saved and not valid is left out. */
export function savedRows(drafts: readonly PresetDraft[]): Array<{ id: string; spec: SnoozePresetSpec }> {
  return drafts.flatMap((d) => {
    const spec = checkDraft(d).spec ?? d.saved
    return spec ? [{ id: d.id, spec }] : []
  })
}

/** The list to store, in row order. */
export function listToSave(drafts: readonly PresetDraft[]): SnoozePresetSpec[] {
  return savedRows(drafts).map((r) => r.spec)
}

/** Every draft that is valid now takes its spec as saved. */
export function markSaved(drafts: readonly PresetDraft[]): PresetDraft[] {
  return drafts.map((d) => {
    const spec = checkDraft(d).spec
    return { ...d, dirty: false, saved: spec ?? d.saved }
  })
}

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

function daysBetween(a: Date, b: Date): number {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return Math.round((day(a) - day(b)) / 86_400_000)
}

/** `today 20:00`, `tomorrow 09:00`, `Tue 09:00` within a week, `Tue 9 Nov 09:00` after. */
export function whenText(at: Date, now: Date): string {
  const days = daysBetween(at, now)
  if (days === 0) return `today ${hhmm(at)}`
  if (days === 1) return `tomorrow ${hhmm(at)}`
  if (days < 7) return `${SHORT_DAYS[at.getDay()]} ${hhmm(at)}`
  return `${SHORT_DAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]} ${hhmm(at)}`
}

/** The time on the right of a menu item: `20:00` today, `Tue 09:00` within a week, `9 Nov` after. */
export function menuHint(at: Date, now: Date): string {
  const days = daysBetween(at, now)
  if (days <= 0) return hhmm(at)
  if (days < 7) return `${SHORT_DAYS[at.getDay()]} ${hhmm(at)}`
  return `${at.getDate()} ${MONTHS[at.getMonth()]}`
}

export type PresetStanding = { shown: true; at: Date } | { shown: false; at: Date; why: string; sameAs?: string }

/**
 * How each saved spec stands in the menu at `now`, in list order, by the
 * resolver's rules: hidden for its own reason, or for a same-minute spec
 * higher in the list.
 */
export function standings(specs: readonly SnoozePresetSpec[], now: Date): PresetStanding[] {
  const taken = new Map<number, string>()
  return specs.map((spec) => {
    const { at, hidden } = presetTiming(spec, now)
    if (hidden === 'ends_late')
      return {
        shown: false,
        at,
        why: `Hidden now: it would end at ${hhmm(at)}. A duration shorter than a day shows only while it ends today before 21:00.`,
      }
    if (hidden === 'too_soon' && spec.kind === 'time')
      return {
        shown: false,
        at,
        why: `Hidden now: today at ${formatClock(spec)} is less than an hour away or has passed. It shows again tomorrow.`,
      }
    const minute = Math.floor(at.getTime() / 60_000)
    const first = taken.get(minute)
    if (first !== undefined)
      return {
        shown: false,
        at,
        sameAs: first,
        why: `Hidden now: it wakes in the same minute as "${first}", which is higher in the list. Move this one up to show it instead.`,
      }
    taken.set(minute, spec.label)
    return { shown: true, at }
  })
}

/** The row's own message lines under its fields, after any field errors. */
export function rowNotice(
  d: PresetDraft,
  standing: PresetStanding | undefined,
): { text: string; tone: 'plain' | 'error' | 'warn' } | null {
  const { errors, spec } = checkDraft(d)
  if (d.dirty) return { text: 'Not saved yet. It saves when you leave the field.', tone: 'plain' }
  if (!spec) {
    const shown = (Object.keys(errors) as DraftField[]).some((f) => d.touched[f])
    if (shown)
      return {
        text: d.saved
          ? `Not saved. The menu keeps the saved "${d.saved.label}" until you fix this.`
          : 'Not saved. It is not in the menu yet.',
        tone: 'error',
      }
    const onlyLabel = Object.keys(errors).length === 1 && errors.label !== undefined
    return { text: onlyLabel ? 'Not saved until it has a label.' : 'Not saved yet.', tone: 'plain' }
  }
  if (standing && !standing.shown) return { text: standing.why, tone: standing.sameAs ? 'warn' : 'plain' }
  return null
}

/** The errors that show: only for a field that lost focus. */
export function shownErrors(d: PresetDraft): Partial<Record<DraftField, string>> {
  const { errors } = checkDraft(d)
  return Object.fromEntries(Object.entries(errors).filter(([f]) => d.touched[f as DraftField]))
}

export type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'failed'; reason: string }

export function statusLine(drafts: readonly PresetDraft[], save: SaveState): { text: string; bad: boolean } {
  const n = drafts.length
  if (drafts.some((d) => d.dirty))
    return { text: 'You have a change that is not saved. It saves when you leave the field.', bad: false }
  const bad = drafts.filter((d) => !checkDraft(d).spec).length
  if (bad > 0)
    return {
      text: `${bad} of ${n} ${n === 1 ? 'preset is' : 'presets are'} not saved until fixed. The menu uses the saved versions.`,
      bad: true,
    }
  if (save.kind === 'saving') return { text: 'Saving...', bad: false }
  if (save.kind === 'failed') return { text: `Not saved: ${save.reason}. Change a preset to try again.`, bad: true }
  return {
    text: `Saved. Your phones use these ${n} ${n === 1 ? 'preset' : 'presets'} the next time they open Snooze.`,
    bad: false,
  }
}

export function resetBody(count: number): string {
  return `Your ${count} ${count === 1 ? 'preset changes' : 'presets change'} to the 4 defaults: Later today, Tonight, Tomorrow morning and Next week. Your phones get the defaults too. You cannot undo this.`
}

/** `Mon 2 Nov at 14:12`, the instant the preview shows. */
export function previewAtText(now: Date): string {
  return `What Snooze shows on ${SHORT_DAYS[now.getDay()]} ${now.getDate()} ${MONTHS[now.getMonth()]} at ${hhmm(now)}.`
}
