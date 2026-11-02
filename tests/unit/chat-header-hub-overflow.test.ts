// @vitest-environment jsdom
/**
 * A narrow chat header moves the Hub chip into its "..." menu: the chip hides
 * at the 480 px step, the menu lists a Hub row at the same step, and the row
 * does what the chip does (scrolls the children strip into view), then closes.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HubChatRef, HubChatView, HubChildView } from '../../src/shared/hub'
import { hubOverflowEntry } from '../../src/renderer/components/hub/HubChip'
import { ToolbarOverflow } from '../../src/renderer/components/ui/toolbar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ref = (id: string): HubChatRef => ({
  id,
  familyIds: [id],
  title: `Chat ${id}`,
  agentType: 'claude-code',
  projectPath: '/repo',
  updatedAt: 0,
})

const child = (id: string): HubChildView => ({
  chat: ref(id),
  liveId: null,
  phase: 'open',
  state: 'paused',
  limit: 'none',
  waitingForSlot: false,
  account: null,
  branch: null,
  lastWake: null,
  lastTurn: null,
})

const parentView: HubChatView = { self: ref('p'), parent: null, children: [child('a'), child('b')], state: null }

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

describe('the Hub row in a narrow chat header', () => {
  it('names the hub and its children, and has no row for a child chat or a chat without children', () => {
    const entry = hubOverflowEntry(parentView, () => null)
    expect(entry).toMatchObject({ key: 'hub', name: 'Hub', valueText: '2 children' })
    expect(hubOverflowEntry({ ...parentView, children: [] }, () => null)).toBeNull()
    expect(hubOverflowEntry({ self: ref('a'), parent: ref('p'), children: [], state: null }, () => null)).toBeNull()
  })

  it('scrolls the children strip into view from the menu, as the chip does, and closes the menu', () => {
    const panel = document.createElement('div')
    const strip = document.createElement('div')
    strip.dataset.testid = 'hub-children-strip'
    const scrollIntoView = vi.fn()
    strip.scrollIntoView = scrollIntoView
    panel.append(strip)

    const entry = hubOverflowEntry(parentView, () => panel)!
    act(() => root.render(createElement(ToolbarOverflow, { entries: [entry], showBelow: 480, side: 'bottom' })))

    const trigger = container.querySelector<HTMLButtonElement>('[data-toolbar-overflow]')!
    expect(trigger.getAttribute('aria-label')).toBe('More options')
    act(() => trigger.click())

    const row = document.querySelector<HTMLButtonElement>('[role="menuitem"][data-overflow-entry="hub"]')!
    expect(row).not.toBeNull()
    expect(row.textContent).toContain('Hub')
    expect(row.textContent).toContain('2 children')
    // The menu focuses its first row, so the keyboard reaches it with Enter.
    expect(document.activeElement).toBe(row)
    // An action row has no "›": it opens nothing.
    expect(row.textContent).not.toContain('›')

    act(() => row.click())
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('hides the chip at the step the header menu lists it at', () => {
    const panel = readFileSync(resolve(__dirname, '../../src/renderer/components/chat/ChatPanel.tsx'), 'utf8')
    expect(panel).toMatch(/<ToolbarItem hideBelow=\{480\}>\s*<HubChip view=\{hub\} \/>/)
    expect(panel).toMatch(/hubOverflowEntry\(hub,[^\n]*\n[^\n]*hideBelow: 480 as const/)
    expect(panel).toMatch(/<Toolbar\s+ref=\{headerRef\}/)
    expect(panel).toContain('<ToolbarOverflow entries={headerOverflow} showBelow={480} side="bottom" align="end" />')
  })
})
