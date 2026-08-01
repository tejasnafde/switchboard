/**
 * Coalesces streaming `content` events so the agent store commits at ~30fps
 * instead of once per token.
 *
 * Each store commit rebuilds the session's message array and re-renders the
 * streaming bubble (full markdown re-parse), which made per-token commits
 * O(tokens x messages) - the single hottest renderer path.
 *
 * Chunks are folded with `mergeContentChunks`, so an increment extends what is
 * pending and a full snapshot replaces it. That operation is associative, which
 * is what makes dropping intermediate commits lossless: folding the batch gives
 * the same text as applying every chunk in order. Last-write-wins would have
 * been correct only while adapters shipped the whole body every token.
 *
 * Ordering: ChatPanel must call `flushThread(tid)` before committing any
 * NON-content event for the same thread (tool.started, turn.completed, ...),
 * otherwise a buffered first chunk could append its message AFTER a tool
 * message that arrived later, flipping message order. Map insertion order
 * preserves multi-message interleaving (assistant + reasoning streams).
 */
import { mergeContentChunks, type ContentChunk } from '@shared/content-stream'

export interface PendingContent {
  threadId: string
  messageId: string
  text: string
  /** True when `text` extends the committed body rather than replacing it. */
  append?: boolean
}

export interface ContentCoalescer {
  push: (threadId: string, messageId: string, chunk: ContentChunk) => void
  /** Commit everything pending for one thread immediately. */
  flushThread: (threadId: string) => void
  /** Commit everything pending and cancel the timer (unmount). */
  dispose: () => void
}

export function createContentCoalescer(
  commit: (p: PendingContent) => void,
  flushMs = 33,
): ContentCoalescer {
  const pending = new Map<string, PendingContent>()
  let timer: ReturnType<typeof setTimeout> | null = null

  function flushAll(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (pending.size === 0) return
    const items = [...pending.values()]
    pending.clear()
    for (const p of items) commit(p)
  }

  return {
    push(threadId, messageId, chunk) {
      const key = `${threadId}\0${messageId}`
      const prior = pending.get(key)
      const merged = prior ? mergeContentChunks(prior, chunk) : chunk
      pending.set(key, { threadId, messageId, text: merged.text, append: merged.append })
      if (!timer) timer = setTimeout(flushAll, flushMs)
    },
    flushThread(threadId) {
      const items: PendingContent[] = []
      for (const [key, p] of pending) {
        if (p.threadId === threadId) {
          items.push(p)
          pending.delete(key)
        }
      }
      if (pending.size === 0 && timer) {
        clearTimeout(timer)
        timer = null
      }
      for (const p of items) commit(p)
    },
    dispose: flushAll,
  }
}
