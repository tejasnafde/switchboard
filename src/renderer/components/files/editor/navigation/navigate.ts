/**
 * Single entry-point for "jump to a path/line" actions across the
 * renderer. Routing through here keeps three concerns aligned:
 *
 *   1. layout-store flips to right-pane Files mode and stores the path.
 *   2. editor-store opens (or focuses) the buffer for that path.
 *   3. Nav history gets a push so ⌘[ / Ctrl+- can step back later.
 *
 * Cursor-only moves *within* the same buffer don't go through here —
 * those are normal CM6 transactions.
 */
import { useLayoutStore } from '../../../../stores/layout-store'
import { useEditorStore } from '../../../../stores/editor-store'

export interface NavTarget {
  path: string
  line?: number
  ch?: number
}

export function navigateTo(sessionId: string | null, target: NavTarget): void {
  // Open in the right pane / viewer; layout-store also flips rightPaneMode
  // to 'files' if it isn't already.
  useLayoutStore.getState().openInViewer(
    target.path,
    target.line ? { start: target.line, end: target.line } : null,
  )
  if (sessionId) {
    useEditorStore.getState().pushNav(sessionId, {
      path: target.path,
      line: target.line ?? 1,
      ch: target.ch ?? 0,
    })
  }
}
