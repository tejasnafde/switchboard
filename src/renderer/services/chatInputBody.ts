/**
 * Pure helpers behind ChatInput's pill-aware text body.
 *
 * The chat input renders inline pill chips (Cursor-style) at arbitrary
 * caret positions. To keep the data layer testable without a DOM, we
 * represent each pill as a token of the form:
 *
 *   [[pill:<id>]]
 *
 * inside the plain-text body. The contenteditable surface owns DOM
 * concerns (rendering tokens as chips, mapping caret offsets) — these
 * functions own the *string arithmetic* that has to stay correct
 * across every interaction.
 *
 * Token format chosen because:
 *   - double brackets don't appear in normal prose, paths, or code,
 *   - ids are opaque so the formatter can be swapped without touching
 *     the token shape,
 *   - simple to grep/scan in a draft string while debugging.
 *
 * Both helpers are unit-tested in `tests/unit/chat-input-body.test.ts`.
 */
import type { DraftPill } from '../stores/draft-store'

const TOKEN_RE = /\[\[pill:([a-zA-Z0-9_-]+)\]\]/g

/**
 * One element of the segmented body. Text segments carry their literal
 * substring; pill segments carry the opaque id (the renderer maps it to
 * a chip via `pillsBySession`).
 */
export type BodySegment =
  | { type: 'text'; text: string }
  | { type: 'pill'; id: string }

/**
 * Inverse of `serializeBodyWithPills` — turns a string with `[[pill:id]]`
 * tokens into an ordered sequence of text / pill segments. Used by the
 * Lexical editor to hydrate its node tree from a saved draft.
 *
 * Malformed pill-shaped strings (single bracket, whitespace in id, etc.)
 * are preserved as plain text — the regex requires double brackets and
 * a strict id charset (`[a-zA-Z0-9_-]+`), so anything that doesn't match
 * falls into the surrounding text segment unchanged.
 */
export function parseBodyToSegments(body: string): BodySegment[] {
  if (!body) return []
  const out: BodySegment[] = []
  // Reset lastIndex on a fresh regex to avoid sticky-state surprises.
  const re = new RegExp(TOKEN_RE.source, 'g')
  let cursor = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    if (m.index > cursor) {
      out.push({ type: 'text', text: body.slice(cursor, m.index) })
    }
    out.push({ type: 'pill', id: m[1] })
    cursor = m.index + m[0].length
  }
  if (cursor < body.length) {
    out.push({ type: 'text', text: body.slice(cursor) })
  }
  return out
}

/**
 * Insert a `[[pill:<id>]]` token at the given caret position. Adds a
 * leading space when the previous char is non-whitespace and a trailing
 * space when the next char is non-whitespace (or we're at end-of-string)
 * so that pills always read as discrete tokens, never glued to prose.
 *
 * Returns the new body and the caret position at the *end* of the
 * inserted run, so the caller can advance the contenteditable selection
 * and the user keeps typing inline.
 */
export function insertPillAtCursor(
  body: string,
  caret: number,
  pillId: string,
): { body: string; caret: number } {
  const len = body.length
  const c = Math.max(0, Math.min(len, caret))

  const prevChar = c > 0 ? body[c - 1] : ''
  const nextChar = c < len ? body[c] : ''

  const prependSpace = c > 0 && !/\s/.test(prevChar)
  // Append a trailing space when at end-of-string OR when the next char
  // isn't already whitespace, so the user can keep typing without
  // butting up against the chip.
  const appendSpace = c >= len || !/\s/.test(nextChar)

  const token = `[[pill:${pillId}]]`
  const insertion = (prependSpace ? ' ' : '') + token + (appendSpace ? ' ' : '')

  const next = body.slice(0, c) + insertion + body.slice(c)
  return { body: next, caret: c + insertion.length }
}

/**
 * Replace every `[[pill:<id>]]` token in `body` with the corresponding
 * pill's `content` string from `pillsById`. Tokens whose ids are no
 * longer in the map (because the user removed the chip) are dropped.
 *
 * Replacement is single-pass and non-recursive — pill content is
 * opaque, so a pill that happens to contain a token-shaped substring
 * is NOT re-expanded. This keeps the wire format predictable even when
 * users paste agent-formatted text into a pill.
 */
export function serializeBodyWithPills(
  body: string,
  pillsById: Record<string, Pick<DraftPill, 'content'>>,
): string {
  return body.replace(TOKEN_RE, (_match, id: string) => {
    const pill = pillsById[id]
    return pill ? pill.content : ''
  })
}
