/**
 * The one rule for folding `content` events into message text.
 *
 * Adapters used to emit the whole accumulated message on every token, costing
 * O(n^2) bytes per reply. Free over local IPC, ruinous over a radio. They now
 * emit an increment where they have one, marked `append`; a snapshot (no
 * `append`) still supersedes, which is what a reload produces.
 *
 * Only safe over a transport that resumes: a client that misses one increment
 * holds text with a hole in it and no way to know.
 *
 * Three places fold these - the renderer's 30fps coalescer, the phone's 50ms
 * batcher, and each store's reducer - so the rule lives here rather than in all
 * three.
 */

export interface ContentChunk {
  text: string
  /** True when `text` is an increment rather than the whole message body. */
  append?: boolean
}

export function applyContentText(previous: string | undefined, chunk: ContentChunk): string {
  return chunk.append ? (previous ?? '') + chunk.text : chunk.text
}

/**
 * Combine two chunks for the same message, so a queue holds one entry per
 * message instead of one per token.
 *
 * Associative, which is what makes coalescing lossless anywhere: folding a
 * batch gives the same text as applying every chunk in order.
 */
export function mergeContentChunks(first: ContentChunk, second: ContentChunk): ContentChunk {
  // A snapshot on the right wins outright: it means "the body is exactly this".
  if (!second.append) return { text: second.text }
  return { text: first.text + second.text, append: first.append }
}
