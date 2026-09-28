/**
 * Lines picked in the Files tab by clicking their numbers. Shift-click
 * extends on the same side inside the same hunk: GitHub refuses a range
 * across two hunks, and Bitbucket anchors it nowhere useful.
 */
export interface LineSelection {
  side: 'new' | 'old'
  hunk: number
  anchor: number
  start: number
  end: number
}

/** The selection after a click on line `n` of hunk `hunk`. Clicking the one selected line again clears it. */
export function nextLineSelection(prev: LineSelection | null, side: 'new' | 'old', hunk: number, n: number, shift: boolean): LineSelection | null {
  const same = prev !== null && prev.side === side && prev.hunk === hunk
  if (shift && same) return { ...prev, start: Math.min(prev.anchor, n), end: Math.max(prev.anchor, n) }
  if (same && prev.start === n && prev.end === n) return null
  return { side, hunk, anchor: n, start: n, end: n }
}
