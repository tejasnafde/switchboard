/**
 * The month grid of the custom snooze dialog: local calendar days, weeks from
 * Monday, and the days a snooze may wake on (today to a year ahead). Pure, so
 * the keys and the month buttons are tested without a DOM.
 */
import { MAX_SNOOZE_MS } from '@shared/chat-snooze'

/** A local calendar day; `month` is 1 to 12. */
export interface CalendarDay {
  year: number
  month: number
  day: number
}

/** Noon, so a DST change never moves the date. */
function noonOf(d: CalendarDay): Date {
  return new Date(d.year, d.month - 1, d.day, 12)
}

function dayOf(date: Date): CalendarDay {
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() }
}

function dayOfInstant(ms: number): CalendarDay {
  return dayOf(new Date(ms))
}

export function addDays(d: CalendarDay, days: number): CalendarDay {
  return dayOf(new Date(d.year, d.month - 1, d.day + days, 12))
}

/** The same day of another month, or that month's last day when it is shorter. */
export function addMonths(d: CalendarDay, months: number): CalendarDay {
  const first = new Date(d.year, d.month - 1 + months, 1, 12)
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0, 12).getDate()
  return { year: first.getFullYear(), month: first.getMonth() + 1, day: Math.min(d.day, last) }
}

export function compareDays(a: CalendarDay, b: CalendarDay): number {
  return a.year - b.year || a.month - b.month || a.day - b.day
}

export function compareMonths(a: CalendarDay, b: CalendarDay): number {
  return a.year - b.year || a.month - b.month
}

export function sameDay(a: CalendarDay, b: CalendarDay): boolean {
  return compareDays(a, b) === 0
}

export function dayKey(d: CalendarDay): string {
  return `${d.year}-${d.month}-${d.day}`
}

/** 0 for Monday to 6 for Sunday. */
function weekdayFromMonday(d: CalendarDay): number {
  return (noonOf(d).getDay() + 6) % 7
}

/** The days a snooze can wake on: today to the day a year from now. */
export function wakeDayRange(now: number): { first: CalendarDay; last: CalendarDay } {
  return { first: dayOfInstant(now), last: dayOfInstant(now + MAX_SNOOZE_MS) }
}

export function clampDay(d: CalendarDay, range: { first: CalendarDay; last: CalendarDay }): CalendarDay {
  if (compareDays(d, range.first) < 0) return range.first
  if (compareDays(d, range.last) > 0) return range.last
  return d
}

/** The month's whole weeks, Monday first, with the neighbouring months' days that fill them. */
export function monthCells(year: number, month: number): CalendarDay[] {
  const first = { year, month, day: 1 }
  const length = new Date(year, month, 0, 12).getDate()
  const lead = weekdayFromMonday(first)
  const count = Math.ceil((lead + length) / 7) * 7
  return Array.from({ length: count }, (_, i) => addDays(first, i - lead))
}

/** Where a key moves the chosen day, kept in range, or null for a key the grid does not take. */
export function moveDay(
  d: CalendarDay,
  key: string,
  range: { first: CalendarDay; last: CalendarDay },
): CalendarDay | null {
  const weekday = weekdayFromMonday(d)
  const moved =
    key === 'ArrowLeft'
      ? addDays(d, -1)
      : key === 'ArrowRight'
        ? addDays(d, 1)
        : key === 'ArrowUp'
          ? addDays(d, -7)
          : key === 'ArrowDown'
            ? addDays(d, 7)
            : key === 'Home'
              ? addDays(d, -weekday)
              : key === 'End'
                ? addDays(d, 6 - weekday)
                : key === 'PageUp'
                  ? addMonths(d, -1)
                  : key === 'PageDown'
                    ? addMonths(d, 1)
                    : null
  return moved && clampDay(moved, range)
}
