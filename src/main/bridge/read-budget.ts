/**
 * The size budget of one `read_chat` answer.
 *
 * The relay carries a result in one WebSocket frame of 64 KiB, so an answer
 * over that is lost: the owner's assistant can see that a chat finished but
 * cannot read its report. A read is budgeted well under the frame instead, and
 * what does not fit is cut with a marker the reader can see, never dropped in
 * silence. Everything here is pure and measured in UTF-8 bytes of JSON, which
 * is what the frame holds, not in characters.
 */

/** Bytes of a value once it is JSON, which is what the frame carries. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

/** What the reader sees in place of the characters a cut took out. */
export function cutMarker(characters: number): string {
  return `\n[... ${characters} characters cut ...]\n`
}

export interface TextChunk {
  text: string
  /** Where `text` starts in the whole text. */
  offset: number
  /** `text` is not the whole text from `offset` to the end. */
  truncated: boolean
  /** Read on from here, or null when nothing is left to read. */
  nextOffset: number | null
}

/**
 * A cut by character count can land between the two halves of an astral
 * character (an emoji), so a slice drops a half left at either end rather
 * than carry a lone surrogate into the answer.
 */
function whole(text: string): string {
  let start = 0
  let end = text.length
  if (end > start && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end -= 1
  if (end > start && text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start += 1
  return start === 0 && end === text.length ? text : text.slice(start, end)
}

/** The most characters of `text` from `from` whose JSON fits `maxBytes`. */
function fitFrom(text: string, from: number, maxBytes: number): number {
  if (maxBytes <= 0) return 0
  let low = 0
  let high = text.length - from
  if (jsonBytes(text.slice(from)) <= maxBytes) return high
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (jsonBytes(text.slice(from, from + mid)) <= maxBytes) low = mid
    else high = mid - 1
  }
  return low
}

/**
 * The whole text when it fits, else its head and its tail with a marker
 * between them, so the reader sees how the report starts and how it ends.
 * `nextOffset` is the end of the head: reading on from there gives the cut
 * part in order.
 */
export function previewText(text: string, maxBytes: number): TextChunk {
  if (jsonBytes(text) <= maxBytes) return { text, offset: 0, truncated: false, nextOffset: null }
  let low = 0
  let high = text.length
  // The marker grows as the kept part shrinks, so each try is measured whole.
  const build = (keep: number): { body: string; head: number } => {
    const head = Math.ceil(keep * 0.6)
    const tail = keep - head
    const cut = text.length - keep
    return {
      body: whole(text.slice(0, head)) + cutMarker(cut) + (tail > 0 ? whole(text.slice(text.length - tail)) : ''),
      head,
    }
  }
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (jsonBytes(build(mid).body) <= maxBytes) low = mid
    else high = mid - 1
  }
  const { body, head } = build(low)
  return { text: body, offset: 0, truncated: true, nextOffset: head }
}

/** The characters from `offset` on that fit, in order: one page of a long text. */
export function windowText(text: string, offset: number, maxBytes: number): TextChunk {
  const from = Math.min(Math.max(offset, 0), text.length)
  const keep = fitFrom(text, from, maxBytes)
  const end = from + keep
  return {
    text: whole(text.slice(from, end)),
    offset: from,
    truncated: end < text.length,
    nextOffset: end < text.length ? end : null,
  }
}
