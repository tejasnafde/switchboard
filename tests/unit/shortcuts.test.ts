import { describe, expect, it } from 'vitest'
import {
  applyShortcutOverrides, findShortcutClashes, formatBinding, matchesBinding, matchShortcut, parseBinding,
  shortcutAccelerator, shortcutLabel, shortcutsFor, SHORTCUTS, type ShortcutKeyInput,
} from '@shared/shortcuts'

const ev = (key: string, mods: Partial<Omit<ShortcutKeyInput, 'key'>> = {}): ShortcutKeyInput =>
  ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods })

describe('shortcut registry', () => {
  it('has unique ids and only well-formed bindings', () => {
    expect(new Set(SHORTCUTS.map((c) => c.id)).size).toBe(SHORTCUTS.length)
    for (const c of SHORTCUTS) for (const b of c.bindings) expect(parseBinding(b), `${c.id} ${b}`).not.toBeNull()
  })

  it('rejects malformed bindings', () => {
    expect(parseBinding('Mod+')).toBeNull()
    expect(parseBinding('Hyper+K')).toBeNull()
  })

  it('lists the macOS-only terminal keys only on macOS', () => {
    expect(shortcutsFor('mac').some((c) => c.id === 'terminal.clear')).toBe(true)
    expect(shortcutsFor('other').some((c) => c.id === 'terminal.clear')).toBe(false)
  })
})

describe('matching', () => {
  it('Mod is ⌘ only on macOS and Ctrl only elsewhere', () => {
    expect(matchesBinding(ev('k', { metaKey: true }), 'Mod+K', 'mac')).toBe(true)
    expect(matchesBinding(ev('k', { ctrlKey: true }), 'Mod+K', 'mac')).toBe(false)
    expect(matchesBinding(ev('k', { ctrlKey: true }), 'Mod+K', 'other')).toBe(true)
    expect(matchesBinding(ev('k', { metaKey: true }), 'Mod+K', 'other')).toBe(false)
  })

  it('is exact about Shift and Alt, and case-insensitive on the key', () => {
    expect(matchesBinding(ev('K', { metaKey: true, shiftKey: true }), 'Mod+K', 'mac')).toBe(false)
    expect(matchesBinding(ev('K', { metaKey: true, shiftKey: true }), 'Mod+Shift+K', 'mac')).toBe(true)
    expect(matchesBinding(ev('k', { metaKey: true, altKey: true }), 'Mod+K', 'mac')).toBe(false)
  })

  it('accepts the shifted symbol the browser reports', () => {
    expect(matchesBinding(ev('}', { metaKey: true, shiftKey: true }), 'Mod+Shift+]', 'mac')).toBe(true)
    expect(matchesBinding(ev('|', { ctrlKey: true, shiftKey: true }), 'Mod+Shift+\\', 'other')).toBe(true)
  })

  it('does not throw on a keydown with no key', () => {
    expect(matchShortcut({ ...ev(''), key: undefined as unknown as string }, 'question.pick', 'mac')).toBe(-1)
  })

  it('returns the binding index for range commands', () => {
    expect(matchShortcut(ev('4', { metaKey: true }), 'terminal.focus-window', 'mac')).toBe(3)
    expect(matchShortcut(ev('0', { metaKey: true }), 'terminal.focus-window', 'mac')).toBe(-1)
  })

  it('never matches a macOS-only command elsewhere', () => {
    expect(matchShortcut(ev('Backspace', { altKey: true }), 'terminal.kill-word', 'other')).toBe(-1)
    expect(matchShortcut(ev('Backspace', { altKey: true }), 'terminal.kill-word', 'mac')).toBe(0)
  })
})

describe('formatting', () => {
  it.each([
    ['Mod+Shift+P', '⌘⇧P', 'Ctrl+Shift+P'],
    ['Mod+Backspace', '⌘⌫', 'Ctrl+Backspace'],
    ['Mod+Alt+ArrowLeft', '⌘⌥←', 'Ctrl+Alt+Left'],
    ['Mod+,', '⌘,', 'Ctrl+,'],
    ['Shift+Enter', 'Shift+Enter', 'Shift+Enter'],
    ['Alt+Enter', '⌥Enter', 'Alt+Enter'],
    ['Mod+Shift+\\', '⌘⇧\\', 'Ctrl+Shift+\\'],
  ])('%s -> %s / %s', (binding, mac, other) => {
    expect(formatBinding(binding, 'mac')).toBe(mac)
    expect(formatBinding(binding, 'other')).toBe(other)
  })

  it('collapses ranges', () => {
    expect(shortcutLabel('terminal.focus-window', 'mac')).toBe('⌘1…9')
    expect(shortcutLabel('terminal.focus-window', 'other')).toBe('Ctrl+1…9')
  })

  it('builds Electron accelerators', () => {
    expect(shortcutAccelerator('app.settings')).toBe('CmdOrCtrl+,')
    expect(shortcutAccelerator('app.force-reload')).toBe('CmdOrCtrl+Shift+R')
    expect(shortcutAccelerator('chat.dual')).toBe('CmdOrCtrl+Shift+\\')
  })
})

describe('overrides', () => {
  it('replaces bindings and ignores malformed or range overrides', () => {
    const cmds = applyShortcutOverrides({
      'chat.quick-prompt': ['Mod+Shift+Y'],
      'app.search': ['Nope+F'],
      'terminal.focus-window': ['Mod+0'],
    })
    expect(shortcutLabel('chat.quick-prompt', 'mac', cmds)).toBe('⌘⇧Y')
    expect(shortcutLabel('app.search', 'mac', cmds)).toBe('⌘⇧F')
    expect(shortcutLabel('terminal.focus-window', 'mac', cmds)).toBe('⌘1…9')
    expect(matchShortcut(ev('k', { metaKey: true }), 'chat.quick-prompt', 'mac', cmds)).toBe(-1)
  })
})

describe('clash detection', () => {
  // Both are deliberate: the global handler for ⌘⌫ yields to text inputs
  // (xterm's textarea counts), and ⌘K in a terminal both opens the quick
  // prompt and clears the screen, as it always has.
  it('finds only the known macOS overlaps in the defaults', () => {
    expect(findShortcutClashes(SHORTCUTS, 'mac')).toEqual([
      { binding: 'Mod+Backspace', a: 'chat.interrupt', b: 'terminal.kill-line' },
      { binding: 'Mod+K', a: 'chat.quick-prompt', b: 'terminal.clear' },
    ])
    expect(findShortcutClashes(SHORTCUTS, 'other')).toEqual([])
  })

  it('flags an override that collides in an overlapping scope, not a disjoint one', () => {
    const clash = applyShortcutOverrides({ 'app.search': ['Mod+B'] })
    expect(findShortcutClashes(clash, 'other')).toEqual([{ binding: 'Mod+B', a: 'app.toggle-sidebar', b: 'app.search' }])
    // approval and card-modal both use Mod+Enter, but never at the same time
    expect(findShortcutClashes(SHORTCUTS, 'other').some((c) => c.binding === 'Mod+Enter')).toBe(false)
  })

  it('compares a shifted symbol with its unshifted key', () => {
    const clash = applyShortcutOverrides({ 'app.search': ['Mod+Shift+}'] })
    expect(findShortcutClashes(clash, 'other')).toEqual([{ binding: 'Mod+Shift+}', a: 'app.search', b: 'terminal.next-tab' }])
  })

  it('treats Mod and Ctrl as the same key off macOS', () => {
    const clash = applyShortcutOverrides({ 'app.search': ['Ctrl+B'] })
    expect(findShortcutClashes(clash, 'other')).toHaveLength(1)
    expect(findShortcutClashes(clash, 'mac')).toEqual(findShortcutClashes(SHORTCUTS, 'mac'))
  })
})
