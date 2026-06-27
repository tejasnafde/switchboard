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

export function navigateTo(_sessionId: string | null, target: NavTarget): void {
  // openInViewer flips to 'files' and records the nav-history entry itself.
  useLayoutStore.getState().openInViewer(
    target.path,
    target.line ? { start: target.line, end: target.line } : null,
  )
}

/** Record the current location before a jump so back returns to it (VS Code-style). */
export function recordLocation(sessionId: string | null, path: string, line: number): void {
  if (sessionId) useEditorStore.getState().pushNav(sessionId, { path, line, ch: 0 })
}
