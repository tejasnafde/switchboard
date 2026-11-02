// @vitest-environment jsdom
/**
 * The footer Undo notice: what it says for Settle, Snooze and Wake, and the
 * narrow layout that moves the wake time to a second line with Undo and the
 * key instead of dropping it.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InboxNotice, undoNoticeParts } from '../../src/renderer/components/sidebar/InboxNotice'
import { useAgentStore, type LastUndo } from '../../src/renderer/stores/agent-store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = new Date(2026, 10, 2, 14, 12)
const base = { id: 'c1', title: 'Debug auth callback', machineId: 'local' }
const snoozed: LastUndo = { ...base, kind: 'snooze', until: new Date(2026, 10, 3, 9, 0).getTime(), pr: null }

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
  useAgentStore.getState().setLastUndo(null)
})

describe('undoNoticeParts', () => {
  it('names the wake time, the PR, or the merged PR as a tail of its own', () => {
    expect(undoNoticeParts(snoozed, NOW)).toEqual({
      verb: 'Snoozed',
      title: base.title,
      joiner: '',
      tail: 'until Tue 09:00',
    })
    expect(undoNoticeParts({ ...base, kind: 'snooze', until: null, pr: 'github:a/b#512' }, NOW).tail).toBe(
      'until PR #512 changes',
    )
    expect(undoNoticeParts({ ...base, kind: 'settle', settledAt: 1, prNumber: 512 }, NOW)).toMatchObject({
      joiner: ':',
      tail: 'PR #512 merged',
    })
    expect(undoNoticeParts({ ...base, kind: 'wake', until: null, pr: null }, NOW).tail).toBe('')
  })
})

describe('InboxNotice', () => {
  it('puts the tail beside Undo and the key, outside the title that truncates', () => {
    act(() => useAgentStore.getState().setLastUndo(snoozed))
    act(() => root.render(createElement(InboxNotice)))
    const line = container.querySelector('.sidebar-inbox-line')!
    expect([...line.children].map((el) => el.className)).toEqual([
      'sidebar-inbox-text',
      'sidebar-inbox-tail',
      'sidebar-inbox-undo',
      'sidebar-inbox-key',
    ])
    expect(line.querySelector('.sidebar-inbox-text')!.textContent).toBe('Snoozed Debug auth callback')
    expect(line.querySelector('.sidebar-inbox-tail')!.textContent).toMatch(/^until /)
    expect(line.querySelector('.sidebar-inbox-text')!.getAttribute('title')).toMatch(
      /^Snoozed Debug auth callback until /,
    )
  })

  it('wraps to two lines in a narrow sidebar and never hides the wake time', () => {
    const css = readFileSync(resolve(__dirname, '../../src/renderer/styles/global.css'), 'utf8')
    const narrow = css.slice(css.indexOf('@container inbox-notice'))
    const block = narrow.slice(0, narrow.indexOf('\n}\n'))
    expect(block).toMatch(/\.sidebar-inbox-line:has\(\.sidebar-inbox-tail\) \{[^}]*flex-wrap: wrap;/)
    expect(block).toMatch(/\.sidebar-inbox-text \{[^}]*flex-basis: 100%;/)
    expect(css).not.toMatch(/\.sidebar-inbox-tail \{[^}]*display: none/)
  })
})
