import { activeShortcuts, currentPlatform, matchShortcut, type ShortcutCommand, type ShortcutKeyInput, type ShortcutPlatform } from '@shared/shortcuts'

export type GlobalKeyAction =
  | { type: 'toggle-sidebar' }
  | { type: 'toggle-data-science' }
  | { type: 'toggle-terminal' }
  | { type: 'toggle-right-pane' }
  | { type: 'toggle-app-view' }
  | { type: 'new-chat' }
  | { type: 'toggle-palette' }
  | { type: 'toggle-search' }
  | { type: 'new-terminal-window'; direction: 'column' | 'row' }
  | { type: 'toggle-dual-chat' }
  | { type: 'interrupt' }
  | { type: 'context-bridge' }
  | { type: 'quick-prompt' }
  | { type: 'new-terminal-tab' }
  | { type: 'cycle-tab'; direction: 'next' | 'prev' }
  | { type: 'focus-direction'; direction: 'left' | 'right' | 'up' | 'down' }
  | { type: 'focus-window'; index: number }

export type GlobalKeyInput = ShortcutKeyInput

const ACTIONS: Record<string, GlobalKeyAction | ((index: number) => GlobalKeyAction)> = {
  'app.toggle-sidebar': { type: 'toggle-sidebar' },
  'app.toggle-data-science': { type: 'toggle-data-science' },
  'app.toggle-terminal': { type: 'toggle-terminal' },
  'app.toggle-right-pane': { type: 'toggle-right-pane' },
  'app.toggle-board': { type: 'toggle-app-view' },
  'chat.new': { type: 'new-chat' },
  'app.command-palette': { type: 'toggle-palette' },
  'app.search': { type: 'toggle-search' },
  'terminal.new-window-right': { type: 'new-terminal-window', direction: 'row' },
  'terminal.new-window-below': { type: 'new-terminal-window', direction: 'column' },
  'chat.dual': { type: 'toggle-dual-chat' },
  'chat.interrupt': { type: 'interrupt' },
  'chat.context-bridge': { type: 'context-bridge' },
  'chat.quick-prompt': { type: 'quick-prompt' },
  'terminal.new-tab': { type: 'new-terminal-tab' },
  'terminal.next-tab': { type: 'cycle-tab', direction: 'next' },
  'terminal.prev-tab': { type: 'cycle-tab', direction: 'prev' },
  'terminal.focus-left': { type: 'focus-direction', direction: 'left' },
  'terminal.focus-right': { type: 'focus-direction', direction: 'right' },
  'terminal.focus-up': { type: 'focus-direction', direction: 'up' },
  'terminal.focus-down': { type: 'focus-direction', direction: 'down' },
  'terminal.focus-window': (index) => ({ type: 'focus-window', index }),
}

/**
 * Which app-wide shortcut a keydown is, or null. On macOS `Mod` is ⌘ only, so
 * Ctrl+K / Ctrl+J / Ctrl+B reach the focused terminal or text field instead
 * of firing an app command (this listener runs in the window capture phase,
 * ahead of xterm).
 */
export function resolveGlobalKeydown(
  e: GlobalKeyInput,
  platform: ShortcutPlatform = currentPlatform(),
  commands: readonly ShortcutCommand[] = activeShortcuts(),
): GlobalKeyAction | null {
  for (const [id, action] of Object.entries(ACTIONS)) {
    const index = matchShortcut(e, id, platform, commands)
    if (index >= 0) return typeof action === 'function' ? action(index) : action
  }
  return null
}
