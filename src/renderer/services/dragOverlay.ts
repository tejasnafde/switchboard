/**
 * A full-viewport shield shown for the duration of a pane-resize drag.
 *
 * Why this exists: the resize handles use pointer capture to keep tracking
 * the cursor. Capture is reliable over normal DOM, but it is BROKEN when the
 * pointer moves over a separately-compositing surface - the code-server
 * `<webview>` (the embedded IDE) or, in some cases, the xterm canvas. When
 * capture is lost there, the terminating `pointerup` never reaches the handle,
 * so the drag never "ends": the `col-resize` cursor, `user-select: none`, and
 * the panels' `pointerEvents: none` overrides stay stuck and the divider is
 * frozen in resize mode until the app is reloaded.
 *
 * The overlay sits above everything (max z-index) with `pointer-events: auto`,
 * so during a drag the pointer is always over a host-document element. That
 * keeps pointer capture intact and guarantees the `pointerup` lands somewhere
 * we can hear it. Handles also listen for `lostpointercapture` as a belt-and-
 * suspenders recovery.
 */
let overlay: HTMLDivElement | null = null

export function showDragOverlay(cursor: 'col-resize' | 'row-resize'): void {
  if (overlay) {
    overlay.style.cursor = cursor
    return
  }
  const el = document.createElement('div')
  el.dataset.dragOverlay = ''
  el.style.position = 'fixed'
  el.style.inset = '0'
  el.style.zIndex = '2147483647'
  el.style.cursor = cursor
  el.style.touchAction = 'none'
  // Transparent, but pointerEvents defaults to auto so it shields child
  // frames (webview / iframe) beneath it for the whole drag.
  document.body.appendChild(el)
  overlay = el
}

export function hideDragOverlay(): void {
  if (!overlay) return
  overlay.remove()
  overlay = null
}

/** Test/introspection helper. */
export function isDragOverlayActive(): boolean {
  return overlay !== null
}
