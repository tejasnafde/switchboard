/**
 * Classify what the ⌘W close gesture should target, based on which pane
 * currently holds focus. ⌘W is intercepted once in main (`before-input-event`)
 * and routed here so the same key does the right thing per context instead of
 * always closing a terminal (which previously killed SSH'd-in ptys from the
 * editor — the scope-by-focus bug).
 */
export type CloseFocus = 'editor' | 'chat-left' | 'chat-right' | 'terminal' | 'other'

/** Minimal shape of the bits of `Element` we touch — keeps this pure-testable. */
export interface ClosestEl {
  closest(selector: string): ClosestEl | null
  getAttribute(name: string): string | null
}

export function classifyCloseFocus(active: ClosestEl | null): CloseFocus {
  if (!active) return 'other'
  // Files pane (tree or editor) wins — closing here must never reach a terminal.
  if (active.closest('[data-context-source="file-viewer"], [data-files-pane]')) return 'editor'
  // A genuinely focused terminal (xterm's textarea lives inside the pane).
  if (active.closest('[data-terminal-pane]')) return 'terminal'
  const panel = active.closest('[data-chat-panel]')
  if (panel) {
    const side = panel.getAttribute('data-chat-panel')
    if (side === 'left') return 'chat-left'
    if (side === 'right') return 'chat-right'
  }
  // Ambiguous (e.g. <body> after a modal closed) — caller must NOT treat this
  // as "close a terminal"; that's how ⌘W was killing SSH'd-in ptys.
  return 'other'
}
