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
}

/** Stored user rebinds: command id → replacement bindings. */
export type ShortcutOverrides = Record<string, string[]>

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
  { id: 'composer.send', label: 'Send message', group: 'Chat', scope: 'composer', bindings: ['Enter'] },
  { id: 'composer.newline', label: 'New line in message', group: 'Chat', scope: 'composer', bindings: ['Shift+Enter'] },
  { id: 'composer.send-other', label: 'Send the other way (queue / steer)', group: 'Chat', scope: 'composer', bindings: ['Alt+Enter'] },
  { id: 'approval.commit-note', label: 'Approve / deny with note', group: 'Chat', scope: 'approval', bindings: ['Mod+Enter'] },
  { id: 'question.pick', label: 'Pick answer N', group: 'Chat', scope: 'question', bindings: digits(''), range: true },
  { id: 'kanban.card-submit', label: 'Save card', group: 'Navigation', scope: 'card-modal', bindings: ['Mod+Enter'] },
  // In-pane find (TerminalPane, useChatSearch, InPaneSearchBar)
  { id: 'pane.find', label: 'Find in pane', group: 'Search', scope: 'pane', bindings: ['Mod+F'] },
  { id: 'search.next', label: 'Next match', group: 'Search', scope: 'search-bar', bindings: ['Enter', 'ArrowDown', 'F3', 'Mod+G'] },
  { id: 'search.prev', label: 'Previous match', group: 'Search', scope: 'search-bar', bindings: ['Shift+Enter', 'ArrowUp', 'Shift+F3', 'Mod+Shift+G'] },
  { id: 'search.close', label: 'Close find', group: 'Search', scope: 'search-bar', bindings: ['Escape'] },
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

export interface ShortcutKeyInput { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }

// US-layout Shift symbols, so `Mod+Shift+]` matches the `}` the browser reports.
const UNSHIFTED: Record<string, string> = { '}': ']', '{': '[', '|': '\\' }

export function matchesBinding(e: ShortcutKeyInput, binding: string, platform: ShortcutPlatform = currentPlatform()): boolean {
  const b = parseBinding(binding)
  if (!b) return false
  const wantMeta = platform === 'mac' && b.mod
  const wantCtrl = b.ctrl || (platform !== 'mac' && b.mod)
  if (e.metaKey !== wantMeta || e.ctrlKey !== wantCtrl || e.shiftKey !== b.shift || e.altKey !== b.alt) return false
  // Chromium autofill can dispatch a keydown with no key.
  const key = e.key?.toLowerCase() ?? ''
  return key === b.key || (e.shiftKey && UNSHIFTED[key] === b.key)
}

/** The registry with stored overrides applied; a malformed override is ignored. */
export function applyShortcutOverrides(
  overrides: ShortcutOverrides | undefined,
  commands: readonly ShortcutCommand[] = SHORTCUTS,
): ShortcutCommand[] {
  return commands.map((c) => {
    const o = overrides?.[c.id]
    if (!o || o.length === 0 || c.range || !o.every((b) => parseBinding(b))) return c
    return { ...c, bindings: o }
  })
}

export function shortcutsFor(platform: ShortcutPlatform, commands: readonly ShortcutCommand[] = SHORTCUTS): ShortcutCommand[] {
  return commands.filter((c) => platform === 'mac' || !c.macOnly)
}

export function getShortcut(id: string, commands: readonly ShortcutCommand[] = SHORTCUTS): ShortcutCommand {
  const c = commands.find((x) => x.id === id)
  if (!c) throw new Error(`unknown shortcut ${id}`)
  return c
}

/** Index of the binding `e` matches on command `id`, or -1. */
export function matchShortcut(
  e: ShortcutKeyInput,
  id: string,
  platform: ShortcutPlatform = currentPlatform(),
  commands: readonly ShortcutCommand[] = SHORTCUTS,
): number {
  const c = getShortcut(id, commands)
  if (c.macOnly && platform !== 'mac') return -1
  return c.bindings.findIndex((b) => matchesBinding(e, b, platform))
}

export const matchesShortcut = (e: ShortcutKeyInput, id: string, platform?: ShortcutPlatform, commands?: readonly ShortcutCommand[]): boolean =>
  matchShortcut(e, id, platform, commands) >= 0

const MAC_KEYS: Record<string, string> = { backspace: '⌫', enter: 'Enter', escape: 'Esc', arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓' }
const OTHER_KEYS: Record<string, string> = { backspace: 'Backspace', enter: 'Enter', escape: 'Esc', arrowleft: 'Left', arrowright: 'Right', arrowup: 'Up', arrowdown: 'Down' }

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

/** The label shown in Settings and the palette: first binding, or `⌘1…9` for a range. */
export function shortcutLabel(
  id: string,
  platform: ShortcutPlatform = currentPlatform(),
  commands: readonly ShortcutCommand[] = SHORTCUTS,
): string {
  const c = getShortcut(id, commands)
  const first = formatBinding(c.bindings[0], platform)
  if (!c.range) return first
  const last = parseBinding(c.bindings[c.bindings.length - 1])!.key.toUpperCase()
  return `${first}…${last}`
}

/** Electron accelerator for a menu item (`Mod` → `CmdOrCtrl`). */
export function shortcutAccelerator(id: string, commands: readonly ShortcutCommand[] = SHORTCUTS): string {
  const b = parseBinding(getShortcut(id, commands).bindings[0])!
  const key = b.key.length === 1 ? b.key.toUpperCase() : b.key.replace(/^arrow/, '').replace(/^./, (ch) => ch.toUpperCase())
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
