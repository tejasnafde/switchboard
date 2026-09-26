/**
 * The one list of keyboard shortcuts. The global resolver, the app menu, the
 * command palette hints and the Settings list all read from here, and
 * components that own their keys match against it.
 *
 * Bindings are written `Mod+Shift+Alt+Key`. `Mod` is ⌘ on macOS and Ctrl
 * elsewhere; on macOS it matches ONLY ⌘, so Ctrl stays with the shell and the
 * Cocoa text bindings (Ctrl+K kill line, Ctrl+W kill word, Ctrl+B back char).
 * Matching is exact: a binding without Shift does not fire with Shift held.
 */

export type ShortcutPlatform = 'mac' | 'other'

/**
 * Where a command listens. `global` and `menu` are app-wide, so they overlap
 * every other scope; the rest only overlap themselves.
 */
export type ShortcutScope =
  | 'global' | 'menu' | 'composer' | 'terminal' | 'pane' | 'search-bar' | 'approval' | 'question' | 'card-modal'

export type ShortcutGroup = 'App' | 'Navigation' | 'Chat' | 'Panels' | 'Terminal' | 'Search'

export interface ShortcutCommand {
  id: string
  label: string
  group: ShortcutGroup
  scope: ShortcutScope
  /** First is the one shown. A `range` command's index is the binding's position. */
  bindings: string[]
  /** Shown as `first…last` (⌘1…9) instead of the first binding. */
  range?: boolean
  /** Only exists on macOS (the ⌘/⌥ terminal line-editing keys). */
  macOnly?: boolean
  /** Cannot be rebound: the key is part of typing or of a widget (see isRebindable). */
  fixed?: boolean
}

/**
 * Settings key for the user's rebinds, a JSON object of command id →
 * replacement bindings (`[]` for unbound). No platform key: the settings DB
 * belongs to one machine, and `Mod` already carries the per-OS meaning.
 */
export const KEYBOARD_OVERRIDES_SETTING = 'keyboard.overrides'

const digits = (prefix: string) => Array.from({ length: 9 }, (_, i) => `${prefix}${i + 1}`)

export const SHORTCUTS: readonly ShortcutCommand[] = [
  // Handled in the renderer's window keydown listener (global-keybindings.ts)
  { id: 'app.toggle-sidebar', label: 'Toggle sidebar', group: 'Panels', scope: 'global', bindings: ['Mod+B', 'Mod+Shift+B'] },
  { id: 'app.toggle-terminal', label: 'Toggle terminal', group: 'Panels', scope: 'global', bindings: ['Mod+J'] },
  { id: 'app.toggle-data-science', label: 'Data science layout (workbench center, chat right)', group: 'Panels', scope: 'global', bindings: ['Mod+Shift+J'] },
  { id: 'app.toggle-right-pane', label: 'Switch right pane (terminal / IDE)', group: 'Panels', scope: 'global', bindings: ['Mod+Shift+E'] },
  { id: 'app.toggle-board', label: 'Toggle kanban board', group: 'Navigation', scope: 'global', bindings: ['Mod+Shift+K'] },
  { id: 'app.command-palette', label: 'Command palette', group: 'Navigation', scope: 'global', bindings: ['Mod+Shift+P'] },
  { id: 'app.search', label: 'Search across chats', group: 'Navigation', scope: 'global', bindings: ['Mod+Shift+F'] },
  { id: 'chat.new', label: 'New chat', group: 'Chat', scope: 'global', bindings: ['Mod+Shift+O'] },
  { id: 'chat.dual', label: 'Toggle dual-chat panel', group: 'Chat', scope: 'global', bindings: ['Mod+Shift+\\'] },
  { id: 'chat.interrupt', label: 'Stop agent (when running)', group: 'Chat', scope: 'global', bindings: ['Mod+Backspace'] },
  { id: 'chat.context-bridge', label: 'Send selection to chat', group: 'Chat', scope: 'global', bindings: ['Mod+L'] },
  { id: 'chat.quick-prompt', label: 'Quick prompt', group: 'Chat', scope: 'global', bindings: ['Mod+K'] },
  { id: 'terminal.new-window-right', label: 'New terminal window (right)', group: 'Terminal', scope: 'global', bindings: ['Mod+T'] },
  { id: 'terminal.new-window-below', label: 'New terminal window (below)', group: 'Terminal', scope: 'global', bindings: ['Mod+Shift+T'] },
  { id: 'terminal.new-tab', label: 'New tab in active window', group: 'Terminal', scope: 'global', bindings: ['Mod+\\'] },
  { id: 'terminal.next-tab', label: 'Next tab', group: 'Terminal', scope: 'global', bindings: ['Mod+Shift+]'] },
  { id: 'terminal.prev-tab', label: 'Previous tab', group: 'Terminal', scope: 'global', bindings: ['Mod+Shift+['] },
  { id: 'terminal.focus-left', label: 'Focus window left', group: 'Terminal', scope: 'global', bindings: ['Mod+Alt+ArrowLeft'] },
  { id: 'terminal.focus-right', label: 'Focus window right', group: 'Terminal', scope: 'global', bindings: ['Mod+Alt+ArrowRight'] },
  { id: 'terminal.focus-up', label: 'Focus window above', group: 'Terminal', scope: 'global', bindings: ['Mod+Alt+ArrowUp'] },
  { id: 'terminal.focus-down', label: 'Focus window below', group: 'Terminal', scope: 'global', bindings: ['Mod+Alt+ArrowDown'] },
  { id: 'terminal.focus-window', label: 'Focus window N', group: 'Terminal', scope: 'global', bindings: digits('Mod+'), range: true },
  // Main process before-input-event (src/main/index.ts), routed by focus in App
  { id: 'terminal.close-tab', label: 'Close active tab', group: 'Terminal', scope: 'global', bindings: ['Mod+W'] },
  { id: 'terminal.close-window', label: 'Close active window', group: 'Terminal', scope: 'global', bindings: ['Mod+Shift+W'] },
  // Electron app menu accelerators (src/main/index.ts)
  { id: 'app.settings', label: 'Open settings', group: 'App', scope: 'menu', bindings: ['Mod+,'] },
  { id: 'app.reload', label: 'Reload window', group: 'App', scope: 'menu', bindings: ['Mod+R'] },
  { id: 'app.force-reload', label: 'Force reload window', group: 'App', scope: 'menu', bindings: ['Mod+Shift+R'] },
  // Chat composer (RichChatTextarea)
  { id: 'composer.send', label: 'Send message', group: 'Chat', scope: 'composer', bindings: ['Enter'], fixed: true },
  { id: 'composer.newline', label: 'New line in message', group: 'Chat', scope: 'composer', bindings: ['Shift+Enter'], fixed: true },
  { id: 'composer.send-other', label: 'Send the other way (queue / steer)', group: 'Chat', scope: 'composer', bindings: ['Alt+Enter'], fixed: true },
  { id: 'approval.commit-note', label: 'Approve / deny with note', group: 'Chat', scope: 'approval', bindings: ['Mod+Enter'] },
  { id: 'question.pick', label: 'Pick answer N', group: 'Chat', scope: 'question', bindings: digits(''), range: true },
  { id: 'kanban.card-submit', label: 'Save card', group: 'Navigation', scope: 'card-modal', bindings: ['Mod+Enter'] },
  // In-pane find (TerminalPane, useChatSearch, InPaneSearchBar)
  { id: 'pane.find', label: 'Find in pane', group: 'Search', scope: 'pane', bindings: ['Mod+F'] },
  { id: 'search.next', label: 'Next match', group: 'Search', scope: 'search-bar', bindings: ['Enter', 'ArrowDown', 'F3', 'Mod+G'], fixed: true },
  { id: 'search.prev', label: 'Previous match', group: 'Search', scope: 'search-bar', bindings: ['Shift+Enter', 'ArrowUp', 'Shift+F3', 'Mod+Shift+G'], fixed: true },
  { id: 'search.close', label: 'Close find', group: 'Search', scope: 'search-bar', bindings: ['Escape'], fixed: true },
  // Terminal line editing (terminal-registry custom key handler), macOS only
  { id: 'terminal.kill-line', label: 'Delete line', group: 'Terminal', scope: 'terminal', bindings: ['Mod+Backspace'], macOnly: true },
  { id: 'terminal.line-start', label: 'Start of line', group: 'Terminal', scope: 'terminal', bindings: ['Mod+ArrowLeft'], macOnly: true },
  { id: 'terminal.line-end', label: 'End of line', group: 'Terminal', scope: 'terminal', bindings: ['Mod+ArrowRight'], macOnly: true },
  { id: 'terminal.clear', label: 'Clear terminal', group: 'Terminal', scope: 'terminal', bindings: ['Mod+K'], macOnly: true },
  { id: 'terminal.kill-word', label: 'Delete word', group: 'Terminal', scope: 'terminal', bindings: ['Alt+Backspace'], macOnly: true },
  { id: 'terminal.word-left', label: 'Word left', group: 'Terminal', scope: 'terminal', bindings: ['Alt+ArrowLeft'], macOnly: true },
  { id: 'terminal.word-right', label: 'Word right', group: 'Terminal', scope: 'terminal', bindings: ['Alt+ArrowRight'], macOnly: true },
]

export interface ParsedBinding { mod: boolean; ctrl: boolean; shift: boolean; alt: boolean; key: string }

/**
 * Range commands (⌘1…9, answer 1…9) are a whole row of keys, not one chord.
 * The composer keys stay fixed because Lexical's Enter handler, IME
 * composition and the @ / slash pickers all assume Enter sends and
 * Shift+Enter breaks the line; letting Enter become a newline would need
 * every picker to learn the swap. The find bar keys are the find widget's own.
 */
export const isRebindable = (c: ShortcutCommand): boolean => !c.range && !c.fixed

const MODIFIERS = new Set(['mod', 'ctrl', 'shift', 'alt'])

/** null for a malformed binding (no key, two keys, unknown modifier). */
export function parseBinding(binding: string): ParsedBinding | null {
  const parts = binding.split('+')
  const key = parts.pop()
  if (!key) return null
  const out: ParsedBinding = { mod: false, ctrl: false, shift: false, alt: false, key: key.toLowerCase() }
  for (const m of parts) {
    const k = m.toLowerCase()
    if (!MODIFIERS.has(k)) return null
    out[k as 'mod' | 'ctrl' | 'shift' | 'alt'] = true
  }
  return out
}

export function currentPlatform(): ShortcutPlatform {
  const g = globalThis as { navigator?: { platform?: string }; process?: { platform?: string } }
  if (g.navigator?.platform) return /mac/i.test(g.navigator.platform) ? 'mac' : 'other'
  return g.process?.platform === 'darwin' ? 'mac' : 'other'
}

export interface ShortcutKeyInput { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }

// US-layout Shift symbols, so `Mod+Shift+]` matches the `}` the browser reports.
const UNSHIFTED: Record<string, string> = { '}': ']', '{': '[', '|': '\\' }

const CODE_KEYS: Record<string, string> = {
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Comma: ',', Period: '.', Slash: '/',
  Semicolon: ';', Quote: "'", Backquote: '`', Minus: '-', Equal: '=', Space: 'space',
}

/** The unmodified key a physical key code stands for (`KeyK` → `k`), or null. */
function keyFromCode(code: string | undefined): string | null {
  if (!code) return null
  const m = /^(?:Key|Digit)(.)$/.exec(code)
  if (m) return m[1].toLowerCase()
  return CODE_KEYS[code] ?? null
}

export function matchesBinding(e: ShortcutKeyInput, binding: string, platform: ShortcutPlatform = currentPlatform()): boolean {
  const b = parseBinding(binding)
  if (!b) return false
  const wantMeta = platform === 'mac' && b.mod
  const wantCtrl = b.ctrl || (platform !== 'mac' && b.mod)
  if (e.metaKey !== wantMeta || e.ctrlKey !== wantCtrl || e.shiftKey !== b.shift || e.altKey !== b.alt) return false
  // Chromium autofill can dispatch a keydown with no key.
  const key = e.key === ' ' ? 'space' : e.key?.toLowerCase() ?? ''
  if (key === b.key || (e.shiftKey && UNSHIFTED[key] === b.key)) return true
  // ⌥ and ⇧ change the character (⌥K is ˚, ⇧1 is !), so fall back to the
  // physical key. ponytail: US positions only; unmodified keys still follow
  // the layout's character, so ⌘Q on AZERTY stays the key labelled Q.
  return (e.altKey || e.shiftKey) && keyFromCode(e.code) === b.key
}

export interface ResolvedShortcuts {
  commands: ShortcutCommand[]
  /** Override ids that were dropped: unknown (another build's), fixed, or malformed. */
  ignored: string[]
}

/**
 * The registry with stored overrides applied. Anything this build cannot use
 * is dropped and reported rather than thrown, so an older and a newer build
 * can share one settings DB.
 */
export function applyShortcutOverrides(
  overrides: unknown,
  commands: readonly ShortcutCommand[] = SHORTCUTS,
): ResolvedShortcuts {
  const map = overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides as Record<string, unknown> : {}
  const byId = new Map(commands.map((c) => [c.id, c]))
  const ignored = Object.keys(map).filter((id) => {
    const c = byId.get(id)
    const o = map[id]
    return !c || !isRebindable(c) || !Array.isArray(o) || !o.every((b) => typeof b === 'string' && parseBinding(b))
  })
  return {
    commands: commands.map((c) => (c.id in map && !ignored.includes(c.id) ? { ...c, bindings: map[c.id] as string[] } : c)),
    ignored,
  }
}

let active: readonly ShortcutCommand[] = SHORTCUTS
let capturing = false

/**
 * Every lookup below defaults to this list. Each process (main, renderer)
 * sets it from the stored settings value; returns what was ignored, for the
 * caller to log (shared code has no logger).
 */
export function setActiveShortcutOverrides(raw: string | null | undefined): string[] {
  let overrides: unknown = {}
  try {
    if (raw) overrides = JSON.parse(raw)
  } catch {
    active = SHORTCUTS
    return ['(unparseable value)']
  }
  const { commands, ignored } = applyShortcutOverrides(overrides)
  active = commands
  return ignored
}

export const activeShortcuts = (): readonly ShortcutCommand[] => active

/** While Settings records a new chord, no shortcut matches, so pressing ⌘B records it instead of hiding the sidebar. */
export function setShortcutCapture(on: boolean): void {
  capturing = on
}

export const isShortcutCaptureActive = (): boolean => capturing

export function shortcutsFor(platform: ShortcutPlatform, commands: readonly ShortcutCommand[] = active): ShortcutCommand[] {
  return commands.filter((c) => platform === 'mac' || !c.macOnly)
}

export function getShortcut(id: string, commands: readonly ShortcutCommand[] = active): ShortcutCommand {
  const c = commands.find((x) => x.id === id)
  if (!c) throw new Error(`unknown shortcut ${id}`)
  return c
}

/** Index of the binding `e` matches on command `id`, or -1. */
export function matchShortcut(
  e: ShortcutKeyInput,
  id: string,
  platform: ShortcutPlatform = currentPlatform(),
  commands: readonly ShortcutCommand[] = active,
): number {
  const c = getShortcut(id, commands)
  if (capturing || (c.macOnly && platform !== 'mac')) return -1
  return c.bindings.findIndex((b) => matchesBinding(e, b, platform))
}

export const matchesShortcut = (e: ShortcutKeyInput, id: string, platform?: ShortcutPlatform, commands?: readonly ShortcutCommand[]): boolean =>
  matchShortcut(e, id, platform, commands) >= 0

const MAC_KEYS: Record<string, string> = { space: 'Space', backspace: '⌫', enter: 'Enter', escape: 'Esc', arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓' }
const OTHER_KEYS: Record<string, string> = { space: 'Space', backspace: 'Backspace', enter: 'Enter', escape: 'Esc', arrowleft: 'Left', arrowright: 'Right', arrowup: 'Up', arrowdown: 'Down' }

export function formatBinding(binding: string, platform: ShortcutPlatform = currentPlatform()): string {
  const b = parseBinding(binding)
  if (!b) return binding
  const key = (platform === 'mac' ? MAC_KEYS : OTHER_KEYS)[b.key] ?? b.key.toUpperCase()
  if (platform === 'mac') {
    // ⌘⇧P, ⌘⌥←; a lone Shift on a named key reads better spelled out (Shift+Enter).
    if (!b.mod && !b.ctrl && !b.alt && b.shift && key.length > 1) return `Shift+${key}`
    return `${b.mod ? '⌘' : ''}${b.ctrl ? '⌃' : ''}${b.shift ? '⇧' : ''}${b.alt ? '⌥' : ''}${key}`
  }
  return [b.mod || b.ctrl ? 'Ctrl' : '', b.shift ? 'Shift' : '', b.alt ? 'Alt' : '', key].filter(Boolean).join('+')
}

/** The label shown in Settings and the palette: first binding, `⌘1…9` for a range, '' when unbound. */
export function shortcutLabel(
  id: string,
  platform: ShortcutPlatform = currentPlatform(),
  commands: readonly ShortcutCommand[] = active,
): string {
  const c = getShortcut(id, commands)
  if (c.bindings.length === 0) return ''
  const first = formatBinding(c.bindings[0], platform)
  if (!c.range) return first
  const last = parseBinding(c.bindings[c.bindings.length - 1])!.key.toUpperCase()
  return `${first}…${last}`
}

/** Electron accelerator for a menu item (`Mod` → `CmdOrCtrl`); undefined when unbound. */
export function shortcutAccelerator(id: string, commands: readonly ShortcutCommand[] = active): string | undefined {
  const first = getShortcut(id, commands).bindings[0]
  if (!first) return undefined
  const b = parseBinding(first)!
  const key = b.key.length === 1 ? b.key.toUpperCase() : b.key === 'space' ? 'Space' : b.key.replace(/^arrow/, '').replace(/^./, (ch) => ch.toUpperCase())
  return [b.mod ? 'CmdOrCtrl' : '', b.ctrl ? 'Ctrl' : '', b.shift ? 'Shift' : '', b.alt ? 'Alt' : '', key].filter(Boolean).join('+')
}

function scopesOverlap(a: ShortcutScope, b: ShortcutScope): boolean {
  const appWide = (s: ShortcutScope) => s === 'global' || s === 'menu'
  return a === b || appWide(a) || appWide(b)
}

/** Canonical per-platform form of a binding, so `Mod+K` and `mod+k` compare equal. */
function bindingKey(binding: string, platform: ShortcutPlatform): string | null {
  const b = parseBinding(binding)
  if (!b) return null
  const meta = platform === 'mac' && b.mod
  const ctrl = b.ctrl || (platform !== 'mac' && b.mod)
  return `${meta ? 'M' : ''}${ctrl ? 'C' : ''}${b.shift ? 'S' : ''}${b.alt ? 'A' : ''}+${UNSHIFTED[b.key] ?? b.key}`
}

export interface ShortcutClash { binding: string; a: string; b: string }

/** Pairs of commands that share a binding in overlapping scopes on `platform`. */
export function findShortcutClashes(
  commands: readonly ShortcutCommand[],
  platform: ShortcutPlatform = currentPlatform(),
): ShortcutClash[] {
  const list = shortcutsFor(platform, commands)
  const clashes: ShortcutClash[] = []
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (!scopesOverlap(list[i].scope, list[j].scope)) continue
      const theirs = new Set(list[j].bindings.map((x) => bindingKey(x, platform)))
      for (const binding of list[i].bindings) {
        if (theirs.has(bindingKey(binding, platform))) clashes.push({ binding, a: list[i].id, b: list[j].id })
      }
    }
  }
  return clashes
}

/**
 * The binding a keydown would record, or null while only modifiers are down
 * (or for the Windows key, which no binding can name). Uses the physical key
 * for letters, digits and punctuation, so ⌥K records `Alt+K`, not `Alt+˚`.
 */
export function chordFromEvent(e: ShortcutKeyInput, platform: ShortcutPlatform = currentPlatform()): string | null {
  if (['Meta', 'Control', 'Shift', 'Alt', 'OS', 'Dead'].includes(e.key)) return null
  if (platform !== 'mac' && e.metaKey) return null
  const physical = keyFromCode(e.code)
  const raw = physical ?? (e.key === ' ' ? 'space' : e.key)
  if (!raw || raw === '+') return null
  const key = raw.length === 1 ? raw.toUpperCase() : raw === 'space' ? 'Space' : raw
  const mod = platform === 'mac' ? e.metaKey : e.ctrlKey
  const ctrl = platform === 'mac' && e.ctrlKey
  return [mod && 'Mod', ctrl && 'Ctrl', e.shiftKey && 'Shift', e.altKey && 'Alt', key].filter(Boolean).join('+')
}

// Keys a text field or list needs for itself, so a bare press cannot be a shortcut.
const TYPING_KEYS = new Set(['enter', 'tab', 'backspace', 'delete', 'escape', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end', 'pageup', 'pagedown', 'space'])

const EDITING = 'Cut, copy, paste, select all and undo belong to text editing.'
const RESERVED: Record<ShortcutPlatform, Record<string, string>> = {
  mac: {
    'Mod+Q': 'macOS quits the app with ⌘Q.',
    'Mod+H': 'macOS hides the app with ⌘H.',
    'Mod+Alt+H': 'macOS hides other apps with ⌥⌘H.',
    'Mod+M': 'macOS minimizes the window with ⌘M.',
    'Mod+Tab': 'macOS switches apps with ⌘Tab.',
    'Mod+Shift+Tab': 'macOS switches apps with ⌘⇧Tab.',
    'Mod+`': "macOS cycles the app's windows with ⌘`.",
    'Mod+Space': 'macOS opens Spotlight with ⌘Space.',
    'Mod+Alt+Space': 'macOS opens a Finder search with ⌥⌘Space.',
    'Mod+Shift+3': 'macOS takes a screenshot with ⌘⇧3.',
    'Mod+Shift+4': 'macOS takes a screenshot with ⌘⇧4.',
    'Mod+Shift+5': 'macOS opens the screenshot tool with ⌘⇧5.',
    'Mod+C': EDITING, 'Mod+V': EDITING, 'Mod+X': EDITING, 'Mod+A': EDITING, 'Mod+Z': EDITING, 'Mod+Shift+Z': EDITING,
  },
  other: {
    'Alt+F4': 'The window manager closes the window with Alt+F4.',
    'Alt+Tab': 'The window manager switches apps with Alt+Tab.',
    'Mod+C': 'Ctrl+C copies text and interrupts the program in a terminal.',
    'Mod+D': 'Ctrl+D ends input in a terminal.',
    'Mod+V': EDITING, 'Mod+X': EDITING, 'Mod+A': EDITING, 'Mod+Z': EDITING, 'Mod+Y': EDITING,
  },
}

/** Why the OS, the terminal or typing owns `binding`, or null when it is free to use. */
export function reservedShortcutReason(binding: string, platform: ShortcutPlatform = currentPlatform()): string | null {
  const b = parseBinding(binding)
  if (!b) return 'This key cannot be part of a shortcut.'
  const canon = bindingKey(binding, platform)
  for (const [reserved, reason] of Object.entries(RESERVED[platform])) {
    if (bindingKey(reserved, platform) === canon) return reason
  }
  const printable = b.key.length === 1
  if (platform === 'mac' && b.ctrl && !b.mod) return 'On macOS, Ctrl keys belong to the terminal and text editing.'
  if (!b.mod && !b.ctrl && (printable || (!b.alt && TYPING_KEYS.has(b.key)))) {
    if (!b.alt) return printable ? 'A key without ⌘ or Ctrl types text. Add a modifier.' : 'Typing and lists need this key. Add a modifier.'
    if (platform === 'mac') return '⌥ with a letter types a special character on macOS. Add ⌘.'
  }
  return null
}

/**
 * Commands `binding` would newly collide with if command `id` took it, in
 * overlapping scopes. Collisions the defaults already ship with (⌘K in a
 * terminal) do not count.
 */
export function shortcutClashesFor(
  id: string,
  binding: string,
  platform: ShortcutPlatform = currentPlatform(),
  commands: readonly ShortcutCommand[] = active,
): ShortcutCommand[] {
  const known = new Set(findShortcutClashes(SHORTCUTS, platform).map((c) => `${c.a} ${c.b}`))
  const next = commands.map((c) => (c.id === id ? { ...c, bindings: [binding] } : c))
  const others = findShortcutClashes(next, platform)
    .filter((c) => (c.a === id || c.b === id) && !known.has(`${c.a} ${c.b}`))
    .map((c) => (c.a === id ? c.b : c.a))
  return commands.filter((c) => others.includes(c.id))
}
