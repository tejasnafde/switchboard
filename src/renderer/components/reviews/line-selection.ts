/**
 * Lines picked in the Files tab by clicking their numbers. Shift-click
 * extends on the same side inside the same hunk: GitHub refuses a range
 * across two hunks, and Bitbucket anchors it nowhere useful. A drag from a
 * line number follows the same rules, clamped to the hunk it started in.
 */
import type { DiffHunk, DiffLine } from '@shared/pull-requests'

export interface LineSelection {
  side: 'new' | 'old'
  hunk: number
  anchor: number
  start: number
  end: number
}

/** The line number `line` has on `side`, or null when it has none there (an added line on the old side). */
export function lineOn(line: DiffLine, side: 'new' | 'old'): number | null {
  return side === 'old' ? (line.kind !== 'add' ? line.oldLine : null) : line.kind !== 'del' ? line.newLine : null
}

/** The selection after a click on line `n` of hunk `hunk`. Clicking the one selected line again clears it. */
export function nextLineSelection(
  prev: LineSelection | null,
  side: 'new' | 'old',
  hunk: number,
  n: number,
  shift: boolean,
): LineSelection | null {
  const same = prev !== null && prev.side === side && prev.hunk === hunk
  if (shift && same) return { ...prev, start: Math.min(prev.anchor, n), end: Math.max(prev.anchor, n) }
  if (same && prev.start === n && prev.end === n) return null
  return { side, hunk, anchor: n, start: n, end: n }
}

/**
 * The selection while dragging from `sel.anchor` over row `n` of hunk `overHunk`.
 * Past the start hunk it clamps to that hunk's first or last line on the side;
 * a row with no line on the side (null) keeps the range as it is.
 */
export function dragLineSelection(
  sel: LineSelection,
  hunk: DiffHunk,
  overHunk: number,
  n: number | null,
): LineSelection {
  const lines = hunk.lines.map((l) => lineOn(l, sel.side)).filter((x): x is number => x !== null)
  if (lines.length === 0) return sel
  const first = Math.min(...lines)
  const last = Math.max(...lines)
  const to = overHunk < sel.hunk ? first : overHunk > sel.hunk ? last : n
  if (to === null) return sel
  const at = Math.min(Math.max(to, first), last)
  return { ...sel, start: Math.min(sel.anchor, at), end: Math.max(sel.anchor, at) }
}

/**
 * The selection and comment box once a drag is released over `range` (null: it never left the
 * pressed line). Only a new range replaces the selection and closes the box, so a drag that ends
 * where it began keeps a half-written comment.
 */
export function afterDrag(
  state: { sel: LineSelection | null; composing: boolean },
  range: LineSelection | null,
): { sel: LineSelection | null; composing: boolean } {
  const same =
    range === null ||
    (state.sel !== null &&
      state.sel.side === range.side &&
      state.sel.hunk === range.hunk &&
      state.sel.start === range.start &&
      state.sel.end === range.end)
  return same ? state : { sel: range, composing: false }
}

/** The sticky file header's height at the top of the diff's scroll pane, kept out of the top band. */
export const EDGE_HEADER_PX = 40
export const EDGE_BAND_PX = 32
export const EDGE_MAX_SPEED_PX = 24

/**
 * Pixels per frame to scroll a pane spanning `top`..`bottom` while a drag holds the pointer at `y`:
 * negative is up, 0 outside both bands. Faster the deeper into a band, capped at EDGE_MAX_SPEED_PX
 * (over the header or past the pane counts as fully in). The top band starts under the file header.
 */
export function edgeScrollSpeed(y: number, top: number, bottom: number): number {
  const speed = (depth: number) => Math.ceil(EDGE_MAX_SPEED_PX * Math.min(1, depth / EDGE_BAND_PX))
  const up = top + EDGE_HEADER_PX + EDGE_BAND_PX - y
  if (up > 0) return -speed(up)
  const down = y - (bottom - EDGE_BAND_PX)
  return down > 0 ? speed(down) : 0
}

/** Where to look for the row under a pointer at `y`: inside the pane and below the file header, so a pointer over either still finds the edge row. */
export function edgeProbeY(y: number, top: number, bottom: number): number {
  return Math.min(Math.max(y, top + EDGE_HEADER_PX), bottom - 1)
}
