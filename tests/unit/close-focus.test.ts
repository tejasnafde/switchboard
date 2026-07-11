import { describe, it, expect } from 'vitest'
import { classifyCloseFocus, type ClosestEl } from '../../src/renderer/closeFocus'

/** Build a fake element whose `closest` matches the given selectors. */
function fakeEl(matches: Record<string, { side?: string }>): ClosestEl {
  return {
    closest(sel) {
      for (const key of Object.keys(matches)) {
        // selector list match: any comma-separated part equal to a registered key
        if (sel.split(',').some((s) => s.trim() === key)) {
          const m = matches[key]
          return { closest: () => null, getAttribute: () => m.side ?? null }
        }
      }
      return null
    },
    getAttribute: () => null,
  }
}

describe('classifyCloseFocus', () => {
  it('returns other for no active element', () => {
    expect(classifyCloseFocus(null)).toBe('other')
  })

  it('classifies the files/editor pane as editor', () => {
    expect(classifyCloseFocus(fakeEl({ '[data-ide-pane]': {} }))).toBe('editor')
    expect(classifyCloseFocus(fakeEl({ '[data-ide-pane]': {} }))).toBe('editor')
  })

  it('classifies a focused terminal pane', () => {
    expect(classifyCloseFocus(fakeEl({ '[data-terminal-pane]': {} }))).toBe('terminal')
  })

  it('classifies chat panels by side', () => {
    expect(classifyCloseFocus(fakeEl({ '[data-chat-panel]': { side: 'left' } }))).toBe('chat-left')
    expect(classifyCloseFocus(fakeEl({ '[data-chat-panel]': { side: 'right' } }))).toBe('chat-right')
  })

  it('prefers editor over chat when both match (files pane never closes a terminal)', () => {
    expect(
      classifyCloseFocus(fakeEl({ '[data-ide-pane]': {}, '[data-chat-panel]': { side: 'left' } })),
    ).toBe('editor')
  })

  it('falls back to other (terminal / app window) when nothing matches', () => {
    expect(classifyCloseFocus(fakeEl({}))).toBe('other')
  })
})
