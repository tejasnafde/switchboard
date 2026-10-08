/**
 * Where the composer's selection goes when focus comes back to it without a
 * click (an overlay closing, a chat panel refocusing its composer). The
 * browser puts the caret at the start of a contenteditable that is focused
 * with `element.focus()`, so the composer remembers its last selection as
 * offsets into the plain-text body (pills count as their `[[pill:id]]`
 * token) and puts it back.
 */
import { parseBodyToSegments } from './chat-input-body'

export interface ComposerSelection {
  anchor: number
  focus: number
}

export interface SavedComposerSelection extends ComposerSelection {
  /** The body the offsets index into. */
  body: string
}

/** True when `offset` falls strictly inside a `[[pill:id]]` token of `body`. */
function insidePill(body: string, offset: number): boolean {
  let at = 0
  for (const seg of parseBodyToSegments(body)) {
    const len = seg.type === 'text' ? seg.text.length : `[[pill:${seg.id}]]`.length
    if (seg.type === 'pill' && offset > at && offset < at + len) return true
    at += len
  }
  return false
}

/**
 * The selection to restore in `body`. Unchanged text keeps the saved
 * selection exactly. Changed text keeps it when both ends still name a
 * position in it, and otherwise puts the caret at the end. A selection saved
 * in an empty composer has no position worth keeping, so it goes to the end.
 */
export function selectionToRestore(saved: SavedComposerSelection, body: string): ComposerSelection {
  if (saved.body === body) return { anchor: saved.anchor, focus: saved.focus }
  const end = { anchor: body.length, focus: body.length }
  if (saved.body === '') return end
  const fits = (offset: number): boolean => offset <= body.length && !insidePill(body, offset)
  return fits(saved.anchor) && fits(saved.focus) ? { anchor: saved.anchor, focus: saved.focus } : end
}
