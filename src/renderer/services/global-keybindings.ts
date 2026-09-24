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

export type GlobalKeyInput = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>

const ARROW_DIRECTIONS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as const

/**
 * Which app-wide shortcut a keydown is, or null. Order matters: it is the
 * first-match chain the window listener used, so e.g. ⌘⇧K is the board and
 * plain ⌘K is the quick prompt.
 */
export function resolveGlobalKeydown(e: GlobalKeyInput): GlobalKeyAction | null {
  if (!e.metaKey && !e.ctrlKey) return null
  const key = e.key
  if (key === 'b' || key === 'B') return { type: 'toggle-sidebar' }
  // ⌘+Shift+J - data scientist mode: workbench center, chat docked right
  if ((key === 'j' || key === 'J') && e.shiftKey) return { type: 'toggle-data-science' }
  if (key === 'j' || key === 'J') return { type: 'toggle-terminal' }
  // ⌘+Shift+E - toggle right pane: terminal ↔ files
  if ((key === 'e' || key === 'E') && e.shiftKey) return { type: 'toggle-right-pane' }
  // ⌘+Shift+K - toggle top-level app view (chats ↔ kanban board)
  if ((key === 'k' || key === 'K') && e.shiftKey) return { type: 'toggle-app-view' }
  // ⌘+Shift+O - new chat: pick the project, then a draft opens
  if ((key === 'o' || key === 'O') && e.shiftKey) return { type: 'new-chat' }
  if ((key === 'p' || key === 'P') && e.shiftKey) return { type: 'toggle-palette' }
  // ⌘+Shift+F - search across conversations
  if ((key === 'f' || key === 'F') && e.shiftKey) return { type: 'toggle-search' }
  // ⌘+⇧+T - new window in a new row (below); ⌘+T - same row (right of active)
  if (key.toLowerCase() === 't') return { type: 'new-terminal-window', direction: e.shiftKey ? 'column' : 'row' }
  // ⌘+Shift+| - toggle dual-chat mode
  if (key === '|' || (key === '\\' && e.shiftKey)) return { type: 'toggle-dual-chat' }
  // ⌘+Backspace - interrupt the current agent turn
  if (key === 'Backspace' && !e.shiftKey && !e.altKey) return { type: 'interrupt' }
  // ⌘+L - context bridge: append the focused selection to the chat draft
  if ((key === 'l' || key === 'L') && !e.shiftKey) return { type: 'context-bridge' }
  // ⌘+K - quick prompt
  if (key === 'k' || key === 'K') return { type: 'quick-prompt' }
  // ⌘+\ - new tab in the active window
  if (key === '\\' && !e.shiftKey) return { type: 'new-terminal-tab' }
  // ⌘+⇧+] / ⌘+⇧+[ - next / prev tab in active window
  if (key === '}' || (key === ']' && e.shiftKey)) return { type: 'cycle-tab', direction: 'next' }
  if (key === '{' || (key === '[' && e.shiftKey)) return { type: 'cycle-tab', direction: 'prev' }
  // ⌘+⌥+Arrow - navigate between windows directionally
  if (e.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) {
    return { type: 'focus-direction', direction: ARROW_DIRECTIONS[key as keyof typeof ARROW_DIRECTIONS] }
  }
  // ⌘+1..9 - focus window by index
  if (key >= '1' && key <= '9') return { type: 'focus-window', index: parseInt(key) - 1 }
  return null
}
