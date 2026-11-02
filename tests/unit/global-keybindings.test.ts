import { describe, expect, it } from 'vitest'
import {
  isUndoKeydown,
  resolveGlobalKeydown,
  undoKeyName,
  type GlobalKeyInput,
} from '../../src/renderer/services/global-keybindings'

function key(k: string, mods: Partial<Omit<GlobalKeyInput, 'key'>> = {}): GlobalKeyInput {
  return { key: k, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, ...mods }
}

describe('resolveGlobalKeydown', () => {
  it.each([
    [key('b'), { type: 'toggle-sidebar' }],
    [key('B', { shiftKey: true }), { type: 'toggle-chat-details' }],
    [key('J', { shiftKey: true }), { type: 'toggle-data-science' }],
    [key('j'), { type: 'toggle-terminal' }],
    [key('E', { shiftKey: true }), { type: 'toggle-right-pane' }],
    [key('K', { shiftKey: true }), { type: 'toggle-app-view' }],
    [key('O', { shiftKey: true }), { type: 'new-chat' }],
    [key('P', { shiftKey: true }), { type: 'toggle-palette' }],
    [key('F', { shiftKey: true }), { type: 'toggle-search' }],
    [key('p'), { type: 'go-to-chat' }],
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

describe('isUndoKeydown', () => {
  const body = { tagName: 'BODY', isContentEditable: false }

  it('takes Cmd+Z on macOS and Ctrl+Z elsewhere, outside text entry', () => {
    expect(isUndoKeydown(key('z'), body, 'mac')).toBe(true)
    expect(isUndoKeydown(key('z', { metaKey: false, ctrlKey: true }), body, 'other')).toBe(true)
    expect(isUndoKeydown(key('z', { metaKey: false, ctrlKey: true }), body, 'mac')).toBe(false)
    expect(isUndoKeydown(key('Z', { shiftKey: true }), body, 'mac')).toBe(false)
    expect(isUndoKeydown(key('z'), null, 'mac')).toBe(true)
  })

  it.each([
    ['an input', { tagName: 'INPUT' }],
    ['a textarea, as a terminal takes keys through', { tagName: 'TEXTAREA' }],
    ['the composer', { tagName: 'DIV', isContentEditable: true }],
  ])('leaves Cmd+Z to %s', (_name, element) => {
    expect(isUndoKeydown(key('z'), element, 'mac')).toBe(false)
  })

  it('names the keys for a screen reader', () => {
    expect(undoKeyName('mac')).toBe('Cmd+Z')
    expect(undoKeyName('other')).toBe('Ctrl+Z')
  })
})
