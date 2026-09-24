/**
 * Lets something that is not a Radix layer, but sits inside one (a panel or
 * editor within Settings), answer Escape itself. Radix dialogs listen on the
 * document, so a window-capture listener runs first; stopping the event there
 * keeps the dialog from closing too. Returns the cleanup.
 */
export function onEscapeFirst(handler: () => void): () => void {
  const listener = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopImmediatePropagation()
    handler()
  }
  window.addEventListener('keydown', listener, true)
  return () => window.removeEventListener('keydown', listener, true)
}
