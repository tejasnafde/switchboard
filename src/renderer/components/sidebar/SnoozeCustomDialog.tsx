/**
 * "Custom date and time...": a month grid, a typed 24-hour time with three
 * quick times, and a line that says when the chat wakes. The grid has one tab
 * stop (the chosen day); the arrows move it by day and week, Home and End to
 * the week's ends, PageUp and PageDown by month, all across month boundaries
 * and never before today or past a year ahead. A wall time that does not
 * exist (a DST gap) is refused by `validateCustomWake`, as is a past one.
 *
 * One host (`SnoozeCustomHost`, in App) serves the row menus, the context
 * menu and the palette: each opens it with `openCustomSnooze`.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { create } from 'zustand'
import { formatClock, parseClock, validateCustomWake, wakeSentence, type WakeCheck } from '@shared/chat-snooze'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { chipClass } from '../ui/chip'
import { cn } from '../../lib/utils'
import {
  addDays,
  addMonths,
  compareDays,
  compareMonths,
  dayKey,
  monthCells,
  moveDay,
  sameDay,
  wakeDayRange,
  clampDay,
  type CalendarDay,
} from './snooze-calendar'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEK_HEAD = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const QUICK_TIMES = ['09:00', '13:00', '20:00']

export const CLOCK_HINT = 'Enter a time from 00:00 to 23:59 as HH:MM'

/** The line under the time field for each result of the check. */
export function wakeLine(result: WakeCheck, at: number | null): string {
  switch (result) {
    case 'ok':
      return `Wakes ${wakeSentence(at!)}`
    case 'past':
      return 'Pick a time in the future'
    case 'too_far':
      return 'Pick a time within a year'
    case 'bad_clock':
      return CLOCK_HINT
    case 'no_such_time':
      return 'That time does not exist on this day'
    case 'no_such_date':
      return 'That date does not exist'
  }
}

/** The time the field starts with: the one the last custom snooze used. */
let lastClock = '09:00'

export type CustomSnoozeOutcome = 'snoozed' | 'cancelled'

export function SnoozeCustomDialog({
  onSnooze,
  onCancel,
  returnFocus,
  now = Date.now,
}: {
  onSnooze: (at: number) => void
  onCancel: () => void
  /** Moves focus once the dialog has closed; without it, focus goes back where it was when it opened. */
  returnFocus?: (outcome: CustomSnoozeOutcome) => void
  now?: () => number
}) {
  const [range] = useState(() => wakeDayRange(now()))
  const [chosen, setChosen] = useState<CalendarDay>(() => clampDay(addDays(range.first, 1), range))
  const [view, setView] = useState<CalendarDay>(() => ({ ...chosen, day: 1 }))
  const [clock, setClock] = useState(lastClock)
  const stopRef = useRef<HTMLButtonElement>(null)
  /** Set by a key, or a click on another month's day: focus follows the chosen day into the new render. */
  const focusStop = useRef(false)
  const outcome = useRef<CustomSnoozeOutcome>('cancelled')

  useLayoutEffect(() => {
    if (!focusStop.current) return
    focusStop.current = false
    stopRef.current?.focus()
  })

  const today = range.first
  const check = validateCustomWake(chosen, clock, now())
  const parsed = parseClock(clock)
  const canPrev = compareMonths(view, today) > 0
  const canNext = compareMonths(view, range.last) < 0

  const choose = (day: CalendarDay, focus: boolean) => {
    setChosen(day)
    if (compareMonths(day, view) !== 0) setView({ ...day, day: 1 })
    focusStop.current = focus
  }

  /** The chosen day moves with the month (the same date, kept in range), so the line and Snooze always match the grid. */
  const shiftMonth = (months: number) => {
    setView(addMonths(view, months))
    setChosen(clampDay(addMonths(chosen, months), range))
  }

  const onGridKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = moveDay(chosen, event.key, range)
    if (!target) return
    event.preventDefault()
    choose(target, true)
  }

  const submit = () => {
    if (check.result !== 'ok' || check.at === null || !parsed) return
    lastClock = formatClock(parsed)
    outcome.current = 'snoozed'
    onSnooze(check.at)
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        overlayClassName="z-[1300]"
        className="sb-floating-surface inset-x-0 top-[18vh] z-[1300] mx-auto w-[280px] rounded-[10px] border border-[var(--border-strong)] p-[14px] text-[12px] text-[var(--text-primary)]"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          stopRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          if (!returnFocus) return
          event.preventDefault()
          returnFocus(outcome.current)
        }}
      >
        <DialogTitle className="mb-[10px] text-[13px] font-[500]">Snooze until</DialogTitle>
        <div className="mb-[6px] flex items-center justify-between">
          <MonthButton label="Previous month" enabled={canPrev} onClick={() => shiftMonth(-1)}>
            &#8249;
          </MonthButton>
          <span className="font-[500]" aria-live="polite">
            {MONTHS[view.month - 1]} {view.year}
          </span>
          <MonthButton label="Next month" enabled={canNext} onClick={() => shiftMonth(1)}>
            &#8250;
          </MonthButton>
        </div>
        <div className="grid grid-cols-7 gap-[2px]" aria-hidden="true">
          {WEEK_HEAD.map((d) => (
            <span key={d} className="py-[2px] text-center text-[10.5px] text-[var(--text-secondary)]">
              {d}
            </span>
          ))}
        </div>
        <div
          role="group"
          aria-label={`${MONTHS[view.month - 1]} ${view.year}`}
          className="grid grid-cols-7 gap-[2px]"
          onKeyDown={onGridKey}
        >
          {monthCells(view.year, view.month).map((day) => {
            const off = compareDays(day, today) < 0 || compareDays(day, range.last) > 0
            const selected = sameDay(day, chosen)
            const isToday = sameDay(day, today)
            const outside = day.month !== view.month
            const name = `${WEEKDAYS[new Date(day.year, day.month - 1, day.day, 12).getDay()]} ${day.day} ${MONTHS[day.month - 1]}`
            return (
              <button
                key={dayKey(day)}
                ref={selected ? stopRef : undefined}
                type="button"
                data-day={dayKey(day)}
                tabIndex={selected ? 0 : -1}
                aria-label={isToday ? `${name}, today` : name}
                aria-pressed={selected}
                aria-disabled={off || undefined}
                aria-current={isToday ? 'date' : undefined}
                onClick={() => {
                  if (!off) choose(day, outside)
                }}
                className={cn(
                  'h-[28px] cursor-pointer rounded-[5px] border-0 bg-transparent text-center text-[12px] text-[var(--text-primary)] outline-none [font-variant-numeric:tabular-nums] hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--border-focus)]',
                  outside && 'text-[var(--text-secondary)]',
                  isToday && 'shadow-[inset_0_0_0_1px_var(--border-focus)]',
                  off && 'cursor-default text-[var(--text-secondary)] line-through hover:bg-transparent',
                  selected &&
                    'bg-primary-fill text-white hover:bg-primary-fill-hover focus-visible:outline-white focus-visible:outline-offset-[-3px]',
                )}
              >
                {day.day}
              </button>
            )
          })}
        </div>
        <div className="mt-[12px] flex items-center gap-[6px] text-[11px] text-[var(--text-secondary)]">
          <label className="flex items-center gap-[6px]">
            Time
            <Input
              value={clock}
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={check.result === 'bad_clock'}
              aria-describedby="snooze-custom-line"
              onChange={(event) => setClock(event.target.value)}
              onBlur={() => {
                if (parsed) setClock(formatClock(parsed))
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submit()
                }
              }}
              className="h-[28px] w-[58px] px-[8px] text-[12px] [font-variant-numeric:tabular-nums]"
            />
          </label>
          <span className="flex gap-[4px]">
            {QUICK_TIMES.map((time) => {
              const pressed = parsed !== null && formatClock(parsed) === time
              return (
                <button
                  key={time}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => setClock(time)}
                  className={cn(
                    chipClass,
                    'px-[6px] [font-variant-numeric:tabular-nums]',
                    pressed && 'border-[var(--border-strong)] font-[500] text-[var(--text-primary)]',
                  )}
                >
                  {time}
                </button>
              )
            })}
          </span>
        </div>
        <div
          id="snooze-custom-line"
          className={cn(
            'mt-[10px] min-h-[15px] text-[11px] [font-variant-numeric:tabular-nums]',
            check.result === 'ok' ? 'text-[var(--text-secondary)]' : 'text-[var(--error)]',
          )}
        >
          {wakeLine(check.result, check.at)}
        </div>
        <div className="mt-[12px] flex justify-end gap-[6px]">
          <Button size="sm" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={check.result !== 'ok'} onClick={submit}>
            Snooze
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** A month button stays focusable at the end of the range, so focus never drops out of the dialog. */
function MonthButton({
  label,
  enabled,
  onClick,
  children,
}: {
  label: string
  enabled: boolean
  onClick: () => void
  children: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={!enabled || undefined}
      onClick={() => {
        if (enabled) onClick()
      }}
      className={cn(
        'grid h-[24px] w-[24px] cursor-pointer place-items-center rounded-[5px] border-0 bg-transparent text-[14px] text-[var(--text-secondary)] outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]',
        !enabled && 'cursor-default opacity-40 hover:bg-transparent hover:text-[var(--text-secondary)]',
      )}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------- host

export interface CustomSnoozeRequest {
  onSnooze: (at: number) => void
  returnFocus?: (outcome: CustomSnoozeOutcome) => void
}

const useCustomSnooze = create<{ request: CustomSnoozeRequest | null; opens: number }>(() => ({
  request: null,
  opens: 0,
}))

export function openCustomSnooze(request: CustomSnoozeRequest): void {
  useCustomSnooze.setState((s) => ({ request, opens: s.opens + 1 }))
}

export function SnoozeCustomHost() {
  const { request, opens } = useCustomSnooze()
  if (!request) return null
  const close = () => useCustomSnooze.setState({ request: null })
  return (
    <SnoozeCustomDialog
      key={opens}
      onSnooze={(at) => {
        close()
        request.onSnooze(at)
      }}
      onCancel={close}
      returnFocus={request.returnFocus}
    />
  )
}
