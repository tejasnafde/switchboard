/**
 * Coalesces cumulative streaming `content` events so the agent store commits
 * at ~30fps instead of once per token.
 *
 * Adapters emit the FULL accumulated message text on every delta (see
 * claude-adapter's partialMessageText), so last-write-wins per
 * (threadId, messageId) is lossless - dropping intermediate snapshots never
 * loses characters. Each store commit rebuilds the session's message array
 * and re-renders the streaming bubble (full markdown re-parse), which made
 * per-token commits O(tokens x messages) - the single hottest renderer path.
 *
 * Ordering: ChatPanel must call `flushThread(tid)` before committing any
 * NON-content event for the same thread (tool.started, turn.completed, ...),
 * otherwise a buffered first snapshot could append its message AFTER a tool
 * message that arrived later, flipping message order. Map insertion order
 * preserves multi-message interleaving (assistant + reasoning streams).
 */

export interface PendingContent {
  threadId: string
  messageId: string
  text: string
}

export interface ContentCoalescer {
  push: (threadId: string, messageId: string, text: string) => void
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
    push(threadId, messageId, text) {
      pending.set(`${threadId}\0${messageId}`, { threadId, messageId, text })
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
