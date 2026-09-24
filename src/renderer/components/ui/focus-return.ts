/**
 * Where focus goes when an overlay with no trigger closes: the element that
 * had focus when it opened, or the chat composer when that element is gone
 * or was only <body> (the overlay opened from a shortcut, or from another
 * overlay that had already closed).
 */
export function focusReturnTarget(saved: Element | null): HTMLElement | null {
  if (saved instanceof HTMLElement && saved !== document.body && saved.isConnected) return saved
  return document.querySelector<HTMLElement>('[data-chat-panel] [contenteditable="true"]')
}
