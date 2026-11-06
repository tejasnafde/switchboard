// @vitest-environment jsdom
/**
 * A narrow chat header moves the Hub chip into its "..." menu: the chip hides
 * at the 480 px step, the menu lists a Hub row at the same step, and the row
 * opens the same children list the chip's popover holds.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HubChatRef, HubChatView, HubChildView } from '../../src/shared/hub'
import { hubOverflowEntry } from '../../src/renderer/components/hub/HubChip'
import { ToolbarOverflow } from '../../src/renderer/components/ui/toolbar'
import { overflowedItems, toolbarTier } from '../../src/renderer/components/ui/toolbar-steps'

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
    const entry = hubOverflowEntry(parentView)
    expect(entry).toMatchObject({ key: 'hub', name: 'Hub', valueText: '2 children' })
    expect(hubOverflowEntry({ ...parentView, children: [] })).toBeNull()
    expect(hubOverflowEntry({ self: ref('a'), parent: ref('p'), children: [], state: null })).toBeNull()
  })

  it('counts the running children in the row, as the chip does', () => {
    const view = { ...parentView, children: [{ ...child('a'), state: 'working' as const }, child('b')] }
    expect(hubOverflowEntry(view)).toMatchObject({ valueText: '2 children · 1 running' })
  })

  it('opens the children list in the menu', () => {
    const entry = hubOverflowEntry(parentView)!
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

    act(() => row.click())
    const list = document.querySelector('[data-testid="hub-children-list"]')!
    expect(list).not.toBeNull()
    expect(list.textContent).toContain('2 open · 0 running')
    expect(list.textContent).toContain('Chat a')
  })

  it('lists the Hub row below 480 px and not above it', () => {
    const entry = { ...hubOverflowEntry(parentView)!, hideBelow: 480 as const }
    expect(overflowedItems([entry], toolbarTier(479)).map((e) => e.key)).toEqual(['hub'])
    expect(overflowedItems([entry], toolbarTier(480))).toEqual([])
  })

  it('hides the chip at the step the header menu lists it at', () => {
    const panel = readFileSync(resolve(__dirname, '../../src/renderer/components/chat/ChatPanel.tsx'), 'utf8')
    expect(panel).toMatch(/<ToolbarItem hideBelow=\{480\}>\s*<HubChip view=\{hub\} \/>/)
    expect(panel).toMatch(/hubOverflowEntry\(hub\)/)
    expect(panel).toMatch(/<Toolbar\s+ref=\{headerRef\}/)
    expect(panel).toContain('<ToolbarOverflow entries={headerOverflow} showBelow={480} side="bottom" align="end" />')
  })
})
