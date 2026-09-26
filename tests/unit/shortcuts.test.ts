import { afterEach, describe, expect, it } from 'vitest'
import {
  activeShortcuts, applyShortcutOverrides as resolve, chordFromEvent, findShortcutClashes, formatBinding, isRebindable,
  matchesBinding, matchShortcut, parseBinding, reservedShortcutReason, setActiveShortcutOverrides, setShortcutCapture,
  shortcutAccelerator, shortcutClashesFor, shortcutLabel, shortcutsFor, SHORTCUTS, type ShortcutKeyInput,
} from '@shared/shortcuts'

const applyShortcutOverrides = (o: unknown) => resolve(o).commands

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

describe('stored overrides', () => {
  afterEach(() => {
    setActiveShortcutOverrides(null)
    setShortcutCapture(false)
  })

  it('merges over the defaults, [] unbinds, and reports what it drops', () => {
    const { commands, ignored } = resolve({
      'chat.interrupt': ['Mod+.'],
      'app.search': [],
      'from.a-newer-build': ['Mod+Shift+Y'],
      'composer.send': ['Mod+Enter'],
      'app.reload': 'Mod+R',
    })
    expect(ignored).toEqual(['from.a-newer-build', 'composer.send', 'app.reload'])
    expect(shortcutLabel('chat.interrupt', 'mac', commands)).toBe('⌘.')
    expect(shortcutLabel('app.search', 'mac', commands)).toBe('')
    expect(shortcutAccelerator('app.search', commands)).toBeUndefined()
    expect(matchShortcut(ev('f', { metaKey: true, shiftKey: true }), 'app.search', 'mac', commands)).toBe(-1)
    expect(shortcutLabel('composer.send', 'mac', commands)).toBe('Enter')
    expect(commands.length).toBe(SHORTCUTS.length)
  })

  it('tolerates a stored value that is not an object', () => {
    expect(resolve(null).commands).toEqual(SHORTCUTS)
    expect(resolve(['Mod+K']).commands).toEqual(SHORTCUTS)
  })

  it('the active list feeds every lookup, and garbage falls back to the defaults', () => {
    expect(setActiveShortcutOverrides(JSON.stringify({ 'chat.quick-prompt': ['Mod+Shift+Y'], nope: ['Mod+1'] }))).toEqual(['nope'])
    expect(shortcutLabel('chat.quick-prompt', 'other')).toBe('Ctrl+Shift+Y')
    expect(matchShortcut(ev('y', { metaKey: true, shiftKey: true }), 'chat.quick-prompt', 'mac')).toBe(0)
    expect(setActiveShortcutOverrides('{not json')).toEqual(['(unparseable value)'])
    expect(activeShortcuts()).toBe(SHORTCUTS)
  })

  it('matches nothing while Settings records a chord', () => {
    setShortcutCapture(true)
    expect(matchShortcut(ev('b', { metaKey: true }), 'app.toggle-sidebar', 'mac')).toBe(-1)
  })

  it('keeps range, composer and find-bar keys fixed', () => {
    const fixed = SHORTCUTS.filter((c) => !isRebindable(c)).map((c) => c.id)
    expect(fixed).toEqual(['terminal.focus-window', 'composer.send', 'composer.newline', 'composer.send-other', 'question.pick', 'search.next', 'search.prev', 'search.close'])
  })
})

describe('recording a chord', () => {
  const key = (k: string, code: string, mods: Partial<Omit<ShortcutKeyInput, 'key'>> = {}) => ({ ...ev(k, mods), code })

  it('names ⌘ Mod on macOS and Ctrl Mod elsewhere', () => {
    expect(chordFromEvent(key('k', 'KeyK', { metaKey: true }), 'mac')).toBe('Mod+K')
    expect(chordFromEvent(key('k', 'KeyK', { ctrlKey: true }), 'mac')).toBe('Ctrl+K')
    expect(chordFromEvent(key('k', 'KeyK', { ctrlKey: true }), 'other')).toBe('Mod+K')
    expect(chordFromEvent(key('k', 'KeyK', { metaKey: true }), 'other')).toBeNull()
  })

  it('records the physical key under ⌥ and ⇧, and waits while only modifiers are down', () => {
    expect(chordFromEvent(key('˚', 'KeyK', { metaKey: true, altKey: true }), 'mac')).toBe('Mod+Alt+K')
    expect(chordFromEvent(key('!', 'Digit1', { metaKey: true, shiftKey: true }), 'mac')).toBe('Mod+Shift+1')
    expect(chordFromEvent(key('ArrowUp', 'ArrowUp', { metaKey: true }), 'mac')).toBe('Mod+ArrowUp')
    expect(chordFromEvent(key('Meta', 'MetaLeft', { metaKey: true }), 'mac')).toBeNull()
  })

  it('the recorded chord then matches the same key press', () => {
    const press = key('˚', 'KeyK', { metaKey: true, altKey: true })
    expect(matchesBinding(press, chordFromEvent(press, 'mac')!, 'mac')).toBe(true)
    const shifted = key('!', 'Digit1', { ctrlKey: true, shiftKey: true })
    expect(matchesBinding(shifted, chordFromEvent(shifted, 'other')!, 'other')).toBe(true)
  })
})

describe('reserved keys', () => {
  it.each([
    ['Mod+Q', 'mac', /quits/],
    ['Mod+Space', 'mac', /Spotlight/],
    ['Mod+C', 'mac', /copy/],
    ['Ctrl+K', 'mac', /terminal/],
    ['Alt+K', 'mac', /special character/],
    ['K', 'mac', /types text/],
    ['Shift+K', 'other', /types text/],
    ['Enter', 'other', /Typing/],
    ['Shift+Tab', 'mac', /Typing/],
    ['Mod+C', 'other', /interrupts/],
    ['Mod+D', 'other', /ends input/],
    ['Alt+F4', 'other', /closes the window/],
  ] as const)('%s on %s is refused', (binding, platform, reason) => {
    expect(reservedShortcutReason(binding, platform)).toMatch(reason)
  })

  it.each([
    ['Mod+.', 'mac'], ['Mod+Shift+Y', 'other'], ['F3', 'mac'], ['Alt+K', 'other'], ['Alt+Backspace', 'mac'], ['Mod+D', 'mac'],
  ] as const)('%s on %s is free', (binding, platform) => {
    expect(reservedShortcutReason(binding, platform)).toBeNull()
  })

  it('leaves every default binding of a rebindable command usable', () => {
    for (const platform of ['mac', 'other'] as const) {
      for (const c of shortcutsFor(platform, SHORTCUTS).filter(isRebindable)) {
        for (const b of c.bindings) expect(reservedShortcutReason(b, platform), `${c.id} ${b} ${platform}`).toBeNull()
      }
    }
  })
})

describe('clash refusal', () => {
  it('names the command a candidate chord collides with', () => {
    expect(shortcutClashesFor('app.search', 'Mod+B', 'mac', SHORTCUTS).map((c) => c.id)).toEqual(['app.toggle-sidebar'])
    expect(shortcutClashesFor('app.search', 'Mod+Shift+Y', 'mac', SHORTCUTS)).toEqual([])
  })

  it('ignores disjoint scopes and the overlaps the defaults ship with', () => {
    // approval and the card modal never show at once
    expect(shortcutClashesFor('approval.commit-note', 'Mod+Enter', 'mac', SHORTCUTS)).toEqual([])
    // ⌘⌫ in a terminal is both stop-agent and kill-line, deliberately
    expect(shortcutClashesFor('chat.interrupt', 'Mod+Backspace', 'mac', SHORTCUTS)).toEqual([])
  })

  it('checks against the stored overrides, not only the defaults', () => {
    const cmds = applyShortcutOverrides({ 'chat.interrupt': ['Mod+.'] })
    expect(shortcutClashesFor('app.search', 'Mod+.', 'mac', cmds).map((c) => c.id)).toEqual(['chat.interrupt'])
    // the freed ⌘⌫ still belongs to the terminal's kill-line
    expect(shortcutClashesFor('app.search', 'Mod+Backspace', 'mac', cmds).map((c) => c.id)).toEqual(['terminal.kill-line'])
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
