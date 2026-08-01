/**
 * The one rule for turning a stream of `content` events into message text.
 *
 * Adapters used to emit the FULL accumulated message on every token, so a reply
 * of n tokens cost O(n^2) bytes on the wire. Locally that is free, and it is
 * why the shape survived. Over a phone's radio it is the single most expensive
 * thing the protocol does: a 4,000 token reply sent cumulatively is tens of
 * megabytes for a few kilobytes of text.
 *
 * So `content` now carries an increment when the adapter has one, marked with
 * `append`. A full snapshot (no `append`) still supersedes whatever came
 * before, which is what a non-streaming provider and a reload both produce.
 *
 * Deltas are only safe because the transport resumes: a client that misses one
 * would otherwise hold text with a hole in the middle and no way to know. The
 * replay in ws-protocol restores missed events in order, and a gap forces a
 * re-seed. Do not use append-mode over a transport without that guarantee.
 *
 * Both the renderer and the phone reduce these events, and both also coalesce
 * them before committing (30fps commits, and a 50ms batch respectively). That
 * is three places where the accumulation rule has to agree, which is exactly
 * the kind of thing that drifts. It lives here instead.
 */

export interface ContentChunk {
  text: string
  /** True when `text` is an increment rather than the whole message body. */
  append?: boolean
}

/**
 * Fold one chunk into the text accumulated so far.
 *
 * `previous` is undefined for the first chunk of a message.
 */
export function applyContentText(previous: string | undefined, chunk: ContentChunk): string {
  return chunk.append ? (previous ?? '') + chunk.text : chunk.text
}

/**
 * Combine two chunks for the SAME message into one, so a queue can hold a
 * single entry per message instead of one per token.
 *
 * This is what makes coalescing safe to do anywhere: the operation is
 * associative, so folding a batch pairwise gives the same answer as applying
 * every chunk in order to the message body.
 *
 * A snapshot on the right wins outright. That is not a special case bolted on:
 * a snapshot means "the body is exactly this", so anything buffered before it
 * is by definition superseded.
 */
export function mergeContentChunks(first: ContentChunk, second: ContentChunk): ContentChunk {
  if (!second.append) return { text: second.text }
  return { text: first.text + second.text, append: first.append }
}
