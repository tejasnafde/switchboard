// @vitest-environment jsdom
/**
 * The Snooze controls on Recents rows: which rows offer Snooze, Settle, Wake
 * and the narrow "..." action, the Snoozed group header, the Woke marker, the
 * menu's items and keys, and keyboard focus kept by chat id across redraws.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RecentSessionsSection,
  type RecentSnoozeProps,
} from '../../src/renderer/components/sidebar/RecentSessionsSection'
import type { RecentSessionItem } from '../../src/renderer/components/sidebar/recent-sessions'
import { snoozePrOf } from '../../src/renderer/components/sidebar/snooze-pr'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
;(globalThis as { CSS?: { escape?: (s: string) => string } }).CSS ??= {}
globalThis.CSS.escape ??= (s: string) => s

const item = (id: string, status: RecentSessionItem['status'], session: Partial<RecentSessionItem['session']> = {}) =>
  ({
    session: {
      id,
      source: 'switchboard',
      title: `Chat ${id}`,
      startedAt: 100,
      messageCount: 1,
      filePath: '',
      ...session,
    },
    projectPath: '/repo',
    projectName: 'repo',
    machineId: 'local',
    status,
    statusLine: 'repo',
  }) as RecentSessionItem

const snoozeProps = (over: Partial<RecentSnoozeProps> = {}): RecentSnoozeProps => ({
  available: () => true,
  onSnooze: vi.fn(async () => true),
  onWake: vi.fn(),
  loadPr: async () => ({ key: 'github:acme/app#512', number: 512 }),
  collapsed: true,
  onSetCollapsed: vi.fn(),
  ...over,
})

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

const render = (
  items: RecentSessionItem[],
  snooze: RecentSnoozeProps | undefined = snoozeProps(),
  onSelect = vi.fn(),
  onSettle: (item: RecentSessionItem) => Promise<boolean> = async () => true,
) =>
  act(() =>
    root.render(createElement(RecentSessionsSection, { items, activeSessionId: null, onSelect, onSettle, snooze })),
  )
const row = (id: string) =>
  container.querySelector<HTMLElement>(`[data-recent-id="${id}"]`)?.closest<HTMLElement>('.sidebar-recent-row') ?? null
const labels = (id: string) =>
  [...(row(id)?.querySelectorAll('.sidebar-recent-actions button') ?? [])].map((b) => b.getAttribute('aria-label'))

describe('row actions', () => {
  it('offers Snooze on Working and Done rows, Settle only on Done, and nothing on Needs you', () => {
    render([item('n', 'approval'), item('w', 'working'), item('d', undefined)])
    expect(labels('n')).toEqual([])
    expect(labels('w')).toEqual(['Snooze Chat w', 'Actions for Chat w'])
    expect(labels('d')).toEqual(['Snooze Chat d', 'Settle Chat d', 'Actions for Chat d'])
  })

  it('hides Snooze for a machine whose backend lacks it', () => {
    render([item('d', undefined)], snoozeProps({ available: () => false }))
    expect(labels('d')).toEqual(['Settle Chat d'])
  })

  it('keeps the full title in a tooltip', () => {
    render([item('w', 'working', { title: 'Prepare release notes for 2.4' })])
    expect(row('w')?.querySelector('.sidebar-recent-title')?.getAttribute('title')).toBe(
      'Prepare release notes for 2.4',
    )
  })

  it('shows Woke in the time cell and marks the row until it is opened', () => {
    render([item('d', undefined, { wokeAt: 5, wokeReason: 'time' })])
    expect(row('d')?.classList.contains('woke')).toBe(true)
    expect(row('d')?.querySelector('.sidebar-recent-time')?.textContent).toBe('Woke')
  })
})

describe('the narrow sidebar', () => {
  const css = readFileSync(resolve(__dirname, '../../src/renderer/styles/global.css'), 'utf8')

  it('folds Snooze and Settle into the "..." action below a 230 px sidebar', () => {
    expect(css).toMatch(/\.sidebar-recents \{\s*container: recents \/ inline-size;/)
    const narrow = css.match(/@container recents \(max-width: 213px\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(narrow).toMatch(/\.sidebar-recent-row\.snoozeable \.sidebar-recent-action-text \{\s*display: none;/)
    expect(narrow).toMatch(/\.sidebar-recent-row\.snoozeable \.sidebar-recent-action-more \{\s*display: inline-block;/)
    expect(css).toMatch(/\.sidebar-recent-action-more \{\s*display: none;/)
  })

  it('gives a Working row the same compact action as a Done row', () => {
    render([item('w', 'working'), item('d', undefined)])
    for (const id of ['w', 'd']) {
      expect(row(id)?.classList.contains('snoozeable')).toBe(true)
      expect(row(id)?.querySelector('.sidebar-recent-action-more')).not.toBeNull()
    }
  })

  it('lists the presets and Settle in the "..." menu', async () => {
    render([item('d', undefined)])
    const more = row('d')!.querySelector<HTMLButtonElement>('button.sidebar-recent-action-more')!
    act(() => more.click())
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent)
    expect(items.some((t) => t?.startsWith('Tomorrow morning'))).toBe(true)
    expect(items.at(-1)).toBe('Settle')
  })
})

describe('the Snooze menu', () => {
  it('lists the presets with their times, the linked PR, and runs the item picked', async () => {
    const onSnooze = vi.fn(async () => true)
    render([item('w', 'working'), item('d', undefined)], snoozeProps({ onSnooze }))
    const trigger = row('w')!.querySelector<HTMLButtonElement>('button[aria-label="Snooze Chat w"]')!
    act(() => trigger.click())
    expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Snooze until')
    await vi.waitFor(() => expect(document.body.textContent).toContain('Until PR #512 changes'))
    const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    expect(items.map((b) => b.textContent)).toContain('Until PR #512 changes')
    // Every time item carries its resolved time on the right.
    for (const b of items.slice(0, -1))
      expect(b.querySelector('span:last-child')?.textContent).toMatch(/\d\d:\d\d|\d+ \w{3}/)
    act(() => items.at(-1)!.click())
    expect(onSnooze).toHaveBeenCalledWith(expect.objectContaining({ session: expect.objectContaining({ id: 'w' }) }), {
      pr: 'github:acme/app#512',
    })
  })

  it('moves with Home and End, opens on ArrowDown, and Escape returns focus to the button', async () => {
    render([item('w', 'working')])
    const trigger = row('w')!.querySelector<HTMLButtonElement>('button[aria-label="Snooze Chat w"]')!
    trigger.focus()
    act(() => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    expect(menu).not.toBeNull()
    await vi.waitFor(() => expect(document.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(2))
    const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    items()[0].focus()
    act(() => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    })
    expect(document.activeElement).toBe(items().at(-1))
    act(() => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    expect(document.activeElement).toBe(items()[0])
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('offers the newest linked PR that is still open', () => {
    const link = (number: number, linkedAt: number, state?: 'open' | 'merged' | 'closed') => ({
      ref: { host: 'github' as const, owner: 'acme', name: 'app', number },
      source: 'manual' as const,
      linkedAt,
      state,
    })
    expect(snoozePrOf([link(1, 1, 'open'), link(2, 3, 'merged'), link(3, 2)])).toEqual({
      key: 'github:acme/app#3',
      number: 3,
    })
    expect(snoozePrOf([link(2, 3, 'closed')])).toBeNull()
  })
})

describe('the Snoozed group', () => {
  const snoozed = [
    item('s2', undefined, { snoozedAt: 1, snoozedUntil: Date.now() + 3 * 86_400_000 }),
    item('s1', 'working', { snoozedAt: 1, snoozedUntil: Date.now() + 60_000 }),
  ]

  it('is collapsed by default with a count, and its header toggles it', () => {
    const onSetCollapsed = vi.fn()
    render([item('d', undefined), ...snoozed], snoozeProps({ onSetCollapsed }))
    const header = container.querySelector<HTMLButtonElement>('.sidebar-recent-group-toggle')!
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(header.textContent).toBe('Snoozed2')
    expect(row('s1')).toBeNull()
    act(() => header.click())
    expect(onSetCollapsed).toHaveBeenLastCalledWith(false)
    act(() => {
      header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(onSetCollapsed).toHaveBeenLastCalledWith(true)
    act(() => {
      header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(onSetCollapsed).toHaveBeenLastCalledWith(false)
  })

  it('lists its rows soonest first, a snoozed Working chat too, with a wake label and Wake', () => {
    const onWake = vi.fn()
    render([item('d', undefined), ...snoozed], snoozeProps({ collapsed: false, onWake }))
    const ids = [...container.querySelectorAll('[data-group="snoozed"] [data-recent-id]')].map((b) =>
      b.getAttribute('data-recent-id'),
    )
    expect(ids).toEqual(['s1', 's2'])
    expect(row('s1')?.querySelector('.sidebar-recent-dot')?.getAttribute('data-dot')).toBe('snoozed')
    expect(row('s1')?.querySelector('.sidebar-recent-time')?.textContent).toMatch(/^\d\d:\d\d$/)
    expect(labels('s1')).toEqual(['Wake Chat s1'])
    act(() => row('s1')!.querySelector<HTMLButtonElement>('button[aria-label="Wake Chat s1"]')!.click())
    expect(onWake).toHaveBeenCalledWith(expect.objectContaining({ session: expect.objectContaining({ id: 's1' }) }))
  })

  it('offers no Wake for a machine whose backend cannot take it', () => {
    render(snoozed, snoozeProps({ collapsed: false, available: () => false }))
    expect(labels('s1')).toEqual([])
  })

  it('stays below Show more when Needs you and Working rows fill the limit', () => {
    const urgent = ['a', 'b', 'c', 'e'].map((id) => item(id, 'working'))
    render([...urgent, item('d', undefined), ...snoozed])
    const order = [...container.querySelector('.sidebar-recents')!.children].map((el) =>
      el.classList.contains('sidebar-recents-actions') ? 'more' : el.getAttribute('data-group'),
    )
    expect(order).toEqual(['working', 'more', 'snoozed'])
  })
})

describe('keyboard focus', () => {
  it('stays on an activated row', () => {
    const onSelect = vi.fn()
    render([item('a', undefined), item('b', undefined)], snoozeProps(), onSelect)
    const button = container.querySelector<HTMLButtonElement>('[data-recent-id="b"]')!
    button.focus()
    act(() => button.click())
    expect(onSelect).toHaveBeenCalled()
    expect(document.activeElement).toBe(button)
  })

  it('comes back to the same chat when a redraw replaces its row', () => {
    render([item('a', undefined), item('b', undefined)])
    container.querySelector<HTMLButtonElement>('[data-recent-id="b"]')!.focus()
    // A background wake moves b to Working: its row is a new element in another group.
    render([item('b', 'working'), item('a', undefined)])
    const now = container.querySelector<HTMLButtonElement>('[data-recent-id="b"]')!
    expect(now.closest('[data-group]')?.getAttribute('data-group')).toBe('working')
    expect(document.activeElement).toBe(now)
  })

  it('is kept when a notice expiry or another row redraws the list', () => {
    render([item('a', undefined), item('b', undefined), item('c', undefined)])
    const b = container.querySelector<HTMLButtonElement>('[data-recent-id="b"]')!
    b.focus()
    render([item('b', undefined), item('c', undefined)])
    expect(document.activeElement?.getAttribute('data-recent-id')).toBe('b')
  })

  it('is not pulled back once the user moved it out of the list', () => {
    render([item('a', undefined), item('b', undefined)])
    container.querySelector<HTMLButtonElement>('[data-recent-id="b"]')!.focus()
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    render([item('b', 'working'), item('a', undefined)])
    expect(document.activeElement).toBe(outside)
  })

  it('moves to the next row after a snooze', async () => {
    render([item('a', undefined), item('b', undefined), item('c', undefined)])
    const trigger = row('b')!.querySelector<HTMLButtonElement>('button[aria-label="Snooze Chat b"]')!
    act(() => trigger.click())
    const next = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) =>
      b.textContent?.startsWith('Tomorrow morning'),
    )!
    act(() => next.click())
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-recent-id')).toBe('c'))
  })

  it('comes back to a row whose snooze was refused, while the handoff still holds it', async () => {
    let refuse: (ok: boolean) => void = () => {}
    const onSnooze = vi.fn(() => new Promise<boolean>((done) => (refuse = done)))
    render([item('a', undefined), item('b', undefined), item('c', undefined)], snoozeProps({ onSnooze }))
    act(() => row('b')!.querySelector<HTMLButtonElement>('button[aria-label="Snooze Chat b"]')!.click())
    const next = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) =>
      b.textContent?.startsWith('Tomorrow morning'),
    )!
    act(() => next.click())
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-recent-id')).toBe('c'))
    await act(async () => refuse(false))
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-recent-id')).toBe('b'))
  })

  it('leaves focus where the user moved it when a settle fails later', async () => {
    let fail: (ok: boolean) => void = () => {}
    const onSettle = vi.fn(() => new Promise<boolean>((done) => (fail = done)))
    render([item('a', undefined), item('b', undefined), item('c', undefined)], snoozeProps(), vi.fn(), onSettle)
    act(() => row('b')!.querySelector<HTMLButtonElement>('button[aria-label="Settle Chat b"]')!.click())
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-recent-id')).toBe('c'))
    container.querySelector<HTMLButtonElement>('[data-recent-id="a"]')!.focus()
    await act(async () => fail(false))
    await new Promise((done) => requestAnimationFrame(done))
    expect(document.activeElement?.getAttribute('data-recent-id')).toBe('a')
  })
})
