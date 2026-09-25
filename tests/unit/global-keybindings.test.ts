import { describe, expect, it } from 'vitest'
import { resolveGlobalKeydown, type GlobalKeyInput } from '../../src/renderer/services/global-keybindings'

function key(k: string, mods: Partial<Omit<GlobalKeyInput, 'key'>> = {}): GlobalKeyInput {
  return { key: k, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, ...mods }
}

describe('resolveGlobalKeydown', () => {
  it.each([
    [key('b'), { type: 'toggle-sidebar' }],
    [key('B', { shiftKey: true }), { type: 'toggle-sidebar' }],
    [key('J', { shiftKey: true }), { type: 'toggle-data-science' }],
    [key('j'), { type: 'toggle-terminal' }],
    [key('E', { shiftKey: true }), { type: 'toggle-right-pane' }],
    [key('K', { shiftKey: true }), { type: 'toggle-app-view' }],
    [key('O', { shiftKey: true }), { type: 'new-chat' }],
    [key('P', { shiftKey: true }), { type: 'toggle-palette' }],
    [key('F', { shiftKey: true }), { type: 'toggle-search' }],
    [key('t'), { type: 'new-terminal-window', direction: 'row' }],
    [key('T', { shiftKey: true }), { type: 'new-terminal-window', direction: 'column' }],
    [key('|', { shiftKey: true }), { type: 'toggle-dual-chat' }],
    [key('\\', { shiftKey: true }), { type: 'toggle-dual-chat' }],
    [key('Backspace'), { type: 'interrupt' }],
    [key('l'), { type: 'context-bridge' }],
    [key('k'), { type: 'quick-prompt' }],
    [key('\\'), { type: 'new-terminal-tab' }],
    [key('}', { shiftKey: true }), { type: 'cycle-tab', direction: 'next' }],
    [key(']', { shiftKey: true }), { type: 'cycle-tab', direction: 'next' }],
    [key('{', { shiftKey: true }), { type: 'cycle-tab', direction: 'prev' }],
    [key('[', { shiftKey: true }), { type: 'cycle-tab', direction: 'prev' }],
    [key('ArrowLeft', { altKey: true }), { type: 'focus-direction', direction: 'left' }],
    [key('ArrowDown', { altKey: true }), { type: 'focus-direction', direction: 'down' }],
    [key('1'), { type: 'focus-window', index: 0 }],
    [key('9'), { type: 'focus-window', index: 8 }],
  ])('%o -> %o', (input, action) => {
    expect(resolveGlobalKeydown(input, 'mac')).toEqual(action)
  })

  it.each([
    key('b', { metaKey: false }),
    key('e'),
    key('o'),
    key('p'),
    key('f'),
    key('Backspace', { shiftKey: true }),
    key('Backspace', { altKey: true }),
    key('L', { shiftKey: true }),
    key(']'),
    key('['),
    key('ArrowLeft'),
    key('0'),
    key('x'),
  ])('%o -> null', (input) => {
    expect(resolveGlobalKeydown(input, 'mac')).toBeNull()
  })

  it('uses Ctrl for Mod off macOS, and leaves Ctrl alone on macOS', () => {
    const ctrlB = key('b', { metaKey: false, ctrlKey: true })
    expect(resolveGlobalKeydown(ctrlB, 'other')).toEqual({ type: 'toggle-sidebar' })
    expect(resolveGlobalKeydown(ctrlB, 'mac')).toBeNull()
    expect(resolveGlobalKeydown(key('b'), 'other')).toBeNull()
  })
})
