/** Classify which pane ⌘W should target, by what currently holds focus. */
export type CloseFocus = 'editor' | 'chat-left' | 'chat-right' | 'terminal' | 'other'

/** Minimal shape of the bits of `Element` we touch — keeps this pure-testable. */
export interface ClosestEl {
  closest(selector: string): ClosestEl | null
  getAttribute(name: string): string | null
}

export function classifyCloseFocus(active: ClosestEl | null): CloseFocus {
  if (!active) return 'other'
  if (active.closest('[data-context-source="file-viewer"], [data-files-pane]')) return 'editor'
  if (active.closest('[data-terminal-pane]')) return 'terminal'
  const panel = active.closest('[data-chat-panel]')
  if (panel) {
    const side = panel.getAttribute('data-chat-panel')
    if (side === 'left') return 'chat-left'
    if (side === 'right') return 'chat-right'
  }
  // Ambiguous (e.g. <body>) — callers must not treat this as "close a terminal".
  return 'other'
}
