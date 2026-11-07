/**
 * The size budget of one `read_chat` answer.
 *
 * The relay carries a result in one WebSocket frame of 64 KiB, so an answer
 * over that is lost: the owner's assistant can see that a chat finished but
 * cannot read its report. A read is budgeted well under the frame instead, and
 * what does not fit is cut with a marker the reader can see, never dropped in
 * silence. Everything here is pure and measured in UTF-8 bytes of JSON, which
 * is what the frame holds, not in characters.
 *
 * Every cut lands on a whole character and every `nextOffset` is a boundary a
 * later read can start from, so reading the head and then page after page
 * gives back the text with nothing lost and nothing twice.
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

const isHighHalf = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLowHalf = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/**
 * `end` moved back off the middle of an astral character (an emoji), so a cut
 * never leaves half of one. The very end of the text is left alone: half a
 * character there is the text's own.
 */
function safeEnd(text: string, end: number): number {
  return end > 0 && end < text.length && isHighHalf(text.charCodeAt(end - 1)) ? end - 1 : end
}

/** `start` moved back onto the start of the character it lands inside. */
function safeStart(text: string, start: number): number {
  return start > 0 && start < text.length && isLowHalf(text.charCodeAt(start)) ? start - 1 : start
}

/** The most characters of `text` from `from` whose JSON fits `maxBytes`. */
function fitFrom(text: string, from: number, maxBytes: number): number {
  const left = text.length - from
  if (jsonBytes(text.slice(from)) <= maxBytes) return left
  let low = 0
  let high = left
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
 * part and the tail, in order.
 */
export function previewText(text: string, maxBytes: number): TextChunk {
  if (jsonBytes(text) <= maxBytes) return { text, offset: 0, truncated: false, nextOffset: null }
  // The marker names the characters between the head and the tail, so each
  // try is built and measured whole.
  const build = (keep: number): { body: string; head: number } => {
    const head = safeEnd(text, Math.min(Math.ceil(keep * 0.6), text.length))
    const tailStart = Math.max(safeStart(text, Math.max(text.length - (keep - head), 0)), head)
    return { body: text.slice(0, head) + cutMarker(tailStart - head) + text.slice(tailStart), head }
  }
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (jsonBytes(build(mid).body) <= maxBytes) low = mid
    else high = mid - 1
  }
  const { body, head } = build(low)
  // Even the marker alone can be more than the caller had left. An empty
  // preview still reads on, rather than hand back more than was asked for.
  if (jsonBytes(body) > maxBytes) return { text: '', offset: 0, truncated: true, nextOffset: 0 }
  return { text: body, offset: 0, truncated: true, nextOffset: head }
}

/**
 * The characters from `offset` on that fit, in order: one page of a long text.
 * A page always holds at least one character, so following `nextOffset`
 * always reaches the end however small the room is.
 */
export function windowText(text: string, offset: number, maxBytes: number): TextChunk {
  const from = safeStart(text, Math.min(Math.max(offset, 0), text.length))
  const left = text.length - from
  const end = left === 0 ? from : safeEnd(text, from + Math.max(fitFrom(text, from, maxBytes), Math.min(2, left)))
  return {
    text: text.slice(from, end),
    offset: from,
    truncated: end < text.length,
    nextOffset: end < text.length ? end : null,
  }
}
