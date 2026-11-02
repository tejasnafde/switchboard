// @vitest-environment jsdom
/**
 * "Custom date and time...": the month grid's days, keys and month buttons
 * (never before the current month, never past a year ahead), the typed time
 * with its quick times and live check, the wake line, Snooze, and Escape with
 * focus back on the row's Snooze button.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLOCK_HINT,
  SnoozeCustomDialog,
  SnoozeCustomHost,
  wakeLine,
} from '../../src/renderer/components/sidebar/SnoozeCustomDialog'
import {
  addMonths,
  monthCells,
  moveDay,
  wakeDayRange,
  type CalendarDay,
} from '../../src/renderer/components/sidebar/snooze-calendar'
import {
  RecentSessionsSection,
  type RecentSnoozeProps,
} from '../../src/renderer/components/sidebar/RecentSessionsSection'
import type { RecentSessionItem } from '../../src/renderer/components/sidebar/recent-sessions'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
;(globalThis as { CSS?: { escape?: (s: string) => string } }).CSS ??= {}
globalThis.CSS.escape ??= (s: string) => s

/** Monday 2 November 2026, 14:12 local. */
const NOW = new Date(2026, 10, 2, 14, 12).getTime()
const day = (year: number, month: number, d: number): CalendarDay => ({ year, month, day: d })

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  // Radix returns focus from a 0 ms timer after the dialog unmounts; let it run here.
  await new Promise((done) => setTimeout(done, 0))
})

const open = (over: { now?: number; onSnooze?: (at: number) => void; onCancel?: () => void } = {}) => {
  const props = { onSnooze: vi.fn(), onCancel: vi.fn(), ...over, now: () => over.now ?? NOW }
  act(() => root.render(createElement(SnoozeCustomDialog, props)))
  return props
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
const monthLabel = () => dialog().querySelector('[role="group"]')!.getAttribute('aria-label')
const named = (name: string) => dialog().querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!
const stop = () => dialog().querySelector<HTMLButtonElement>('[role="group"] button[tabindex="0"]')!
const field = () => dialog().querySelector<HTMLInputElement>('input')!
const line = () => document.getElementById('snooze-custom-line')!.textContent
const snoozeButton = () => [...dialog().querySelectorAll('button')].find((b) => b.textContent === 'Snooze')!
const chip = (time: string) => [...dialog().querySelectorAll('button')].find((b) => b.textContent === time)!
const press = (key: string) =>
  act(() => {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
const type = (value: string) =>
  act(() => {
    const input = field()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

describe('the month grid model', () => {
  it('lays out whole weeks from Monday with the neighbouring days', () => {
    const cells = monthCells(2026, 11)
    expect(cells).toHaveLength(42)
    expect(cells[0]).toEqual(day(2026, 10, 26))
    expect(cells.at(-1)).toEqual(day(2026, 12, 6))
    // February 2027 starts on a Monday and fills exactly four weeks.
    expect(monthCells(2027, 2)).toHaveLength(28)
  })

  it('moves by day and week across months, and keeps a short month on its last day', () => {
    const range = wakeDayRange(NOW)
    expect(moveDay(day(2026, 11, 30), 'ArrowRight', range)).toEqual(day(2026, 12, 1))
    expect(moveDay(day(2026, 11, 28), 'ArrowDown', range)).toEqual(day(2026, 12, 5))
    expect(moveDay(day(2026, 11, 4), 'Home', range)).toEqual(day(2026, 11, 2))
    expect(moveDay(day(2026, 11, 4), 'End', range)).toEqual(day(2026, 11, 8))
    expect(moveDay(day(2027, 1, 31), 'PageDown', range)).toEqual(day(2027, 2, 28))
    expect(addMonths(day(2027, 3, 31), -1)).toEqual(day(2027, 2, 28))
    expect(moveDay(day(2026, 11, 4), 'Enter', range)).toBeNull()
  })

  it('never moves before today or past a year ahead', () => {
    const range = wakeDayRange(NOW)
    expect(moveDay(day(2026, 11, 3), 'ArrowUp', range)).toEqual(day(2026, 11, 2))
    expect(moveDay(day(2026, 11, 2), 'PageUp', range)).toEqual(day(2026, 11, 2))
    expect(range.last).toEqual(day(2027, 11, 2))
    expect(moveDay(day(2027, 10, 30), 'PageDown', range)).toEqual(day(2027, 11, 2))
  })
})

describe('the dialog', () => {
  it('opens on tomorrow at 09:00 with focus on the chosen day, today ringed, past days disabled', () => {
    open()
    expect(dialog().querySelector('h2')?.textContent).toBe('Snooze until')
    expect(document.activeElement).toBe(stop())
    expect(stop().getAttribute('aria-label')).toBe('Tue 3 Nov')
    expect(stop().getAttribute('aria-pressed')).toBe('true')
    expect(named('Mon 2 Nov, today').getAttribute('aria-current')).toBe('date')
    expect(named('Sun 1 Nov').getAttribute('aria-disabled')).toBe('true')
    expect(named('Sun 1 Nov').className).toContain('line-through')
    // One tab stop in the grid.
    expect(dialog().querySelectorAll('[role="group"] button[tabindex="0"]')).toHaveLength(1)
    expect(line()).toBe('Wakes Tue 3 Nov at 09:00')
  })

  it('moves the chosen day with the arrows and keeps focus on it, across a month boundary', () => {
    open()
    press('ArrowRight')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Wed 4 Nov')
    expect(line()).toBe('Wakes Wed 4 Nov at 09:00')
    for (let i = 0; i < 4; i++) press('ArrowDown')
    expect(monthLabel()).toBe('Dec 2026')
    expect(document.activeElement).toBe(stop())
    expect(stop().getAttribute('aria-label')).toBe('Wed 2 Dec')
    press('PageUp')
    expect(monthLabel()).toBe('Nov 2026')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Mon 2 Nov, today')
  })

  it('keeps the same day element while the month does not change', () => {
    open()
    const first = named('Fri 6 Nov')
    press('ArrowRight')
    expect(named('Fri 6 Nov')).toBe(first)
  })

  it('disables Previous month in the current month: it neither moves nor throws', () => {
    open()
    const prev = named('Previous month')
    expect(prev.getAttribute('aria-disabled')).toBe('true')
    act(() => prev.click())
    expect(monthLabel()).toBe('Nov 2026')
    expect(line()).toBe('Wakes Tue 3 Nov at 09:00')
    expect(stop()).not.toBeNull()
  })

  it('moves the chosen day with the month buttons, so the line and Snooze match the grid', () => {
    open()
    act(() => named('Next month').click())
    expect(monthLabel()).toBe('Dec 2026')
    expect(line()).toBe('Wakes Thu 3 Dec at 09:00')
    expect(named('Previous month').getAttribute('aria-disabled')).toBeNull()
    act(() => named('Previous month').click())
    expect(line()).toBe('Wakes Tue 3 Nov at 09:00')
  })

  it('at the end of a month opens on the next month and goes back to the current one only', () => {
    open({ now: new Date(2026, 10, 30, 10, 0).getTime() })
    expect(monthLabel()).toBe('Dec 2026')
    expect(stop().getAttribute('aria-label')).toBe('Tue 1 Dec')
    act(() => named('Previous month').click())
    expect(monthLabel()).toBe('Nov 2026')
    // 1 Nov is past: the chosen day is kept in range, on today.
    expect(stop().getAttribute('aria-label')).toBe('Mon 30 Nov, today')
    expect(named('Previous month').getAttribute('aria-disabled')).toBe('true')
    act(() => named('Previous month').click())
    expect(monthLabel()).toBe('Nov 2026')
  })

  it('stops Next month a year ahead', () => {
    open()
    for (let i = 0; i < 14; i++) act(() => named('Next month').click())
    expect(monthLabel()).toBe('Nov 2027')
    expect(named('Next month').getAttribute('aria-disabled')).toBe('true')
    expect(named('Wed 3 Nov').getAttribute('aria-disabled')).toBe('true')
    expect(line()).toBe('Wakes Tue 2 Nov at 09:00')
  })

  it('flags an hour that is not one, with the hint linked to the field, and disables Snooze', () => {
    open()
    type('25:00')
    expect(field().getAttribute('aria-invalid')).toBe('true')
    expect(field().getAttribute('aria-describedby')).toBe('snooze-custom-line')
    expect(line()).toBe(CLOCK_HINT)
    expect(snoozeButton().disabled).toBe(true)
    type('9:05')
    expect(field().getAttribute('aria-invalid')).toBe('false')
    expect(line()).toBe('Wakes Tue 3 Nov at 09:05')
    act(() => field().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(field().value).toBe('09:05')
  })

  it('says a past time is past and disables Snooze', () => {
    open()
    press('ArrowLeft')
    expect(stop().getAttribute('aria-label')).toBe('Mon 2 Nov, today')
    expect(line()).toBe('Pick a time in the future')
    expect(snoozeButton().disabled).toBe(true)
    press('ArrowLeft')
    expect(stop().getAttribute('aria-label')).toBe('Mon 2 Nov, today')
  })

  it('fills the time from a quick chip, presses it, and snoozes to that instant', () => {
    const { onSnooze } = open()
    act(() => chip('13:00').click())
    expect(field().value).toBe('13:00')
    expect(chip('13:00').getAttribute('aria-pressed')).toBe('true')
    expect(chip('09:00').getAttribute('aria-pressed')).toBe('false')
    expect(line()).toBe('Wakes Tue 3 Nov at 13:00')
    act(() => snoozeButton().click())
    expect(onSnooze).toHaveBeenCalledWith(new Date(2026, 10, 3, 13, 0).getTime())
  })

  it('cancels on Escape', () => {
    const { onCancel, onSnooze } = open()
    press('Escape')
    expect(onCancel).toHaveBeenCalled()
    expect(onSnooze).not.toHaveBeenCalled()
  })

  it('words every result of the check', () => {
    expect(wakeLine('no_such_time', null)).toBe('That time does not exist on this day')
    expect(wakeLine('too_far', null)).toBe('Pick a time within a year')
  })
})

describe('from a Recents row', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  const item = {
    session: { id: 'w', source: 'switchboard', title: 'Chat w', startedAt: 100, messageCount: 1, filePath: '' },
    projectPath: '/repo',
    projectName: 'repo',
    machineId: 'local',
    status: 'working',
    statusLine: 'repo',
  } as RecentSessionItem
  const snooze = (onSnooze: RecentSnoozeProps['onSnooze']): RecentSnoozeProps => ({
    available: () => true,
    onSnooze,
    onWake: vi.fn(),
    loadPr: async () => null,
    collapsed: true,
    onSetCollapsed: vi.fn(),
  })
  const render = (onSnooze: RecentSnoozeProps['onSnooze']) =>
    act(() =>
      root.render(
        createElement('div', null, [
          createElement(RecentSessionsSection, {
            key: 'list',
            items: [item],
            activeSessionId: null,
            onSelect: vi.fn(),
            snooze: snooze(onSnooze),
          }),
          createElement(SnoozeCustomHost, { key: 'host' }),
        ]),
      ),
    )
  const openFromMenu = () => {
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Snooze Chat w"]')!
    trigger.focus()
    act(() => trigger.click())
    const custom = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (b) => b.textContent === 'Custom date and time...',
    )!
    act(() => custom.click())
    return trigger
  }

  it('returns focus to the row Snooze button on Escape', async () => {
    render(vi.fn(async () => true))
    const trigger = openFromMenu()
    expect(dialog()).not.toBeNull()
    expect(document.activeElement).toBe(stop())
    press('Escape')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('sends the composed instant through the row, as preset custom', () => {
    const onSnooze = vi.fn(async () => true)
    render(onSnooze)
    openFromMenu()
    act(() => chip('20:00').click())
    act(() => snoozeButton().click())
    expect(onSnooze).toHaveBeenCalledWith(expect.objectContaining({ session: expect.objectContaining({ id: 'w' }) }), {
      at: new Date(2026, 10, 3, 20, 0).getTime(),
    })
  })

  it('opens the next time with the time the last snooze used', () => {
    render(vi.fn(async () => true))
    openFromMenu()
    type('7:45')
    act(() => snoozeButton().click())
    openFromMenu()
    expect(field().value).toBe('07:45')
  })
})
