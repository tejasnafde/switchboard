/**
 * A zustand `persist` storage that writes at most once per window.
 *
 * The chat store commits a batch every 50ms while an agent streams, and
 * `persist` writes on every commit. Handing that straight to AsyncStorage means
 * ~20 serializations a second of the whole thread map, on the JS thread, during
 * the exact interval the feed is trying to render smoothly.
 *
 * So writes coalesce: only the newest value for a key survives the window, and
 * a read still sees it because pending writes are served from memory. Reads and
 * removes are pass-through.
 *
 * Losing the last window's worth of writes on a hard kill is acceptable, and is
 * the whole trade. This is a cache of something the backend still owns, not a
 * record of user intent - that lives in the outbox, which writes durably and
 * immediately.
 */
import type { StateStorage } from 'zustand/middleware'

export const DEFAULT_WRITE_DEBOUNCE_MS = 500

export interface DebouncedStorage extends StateStorage {
  /** Write anything pending right now. For teardown and tests. */
  flush: () => Promise<void>
}

export function createDebouncedStorage(
  inner: StateStorage,
  debounceMs = DEFAULT_WRITE_DEBOUNCE_MS,
): DebouncedStorage {
  const pending = new Map<string, string>()
  let timer: ReturnType<typeof setTimeout> | null = null

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (pending.size === 0) return
    const batch = [...pending]
    pending.clear()
    await Promise.all(batch.map(([key, value]) => inner.setItem(key, value)))
  }

  return {
    getItem: async (key) => {
      // A pending write is newer than anything on disk, so serve it. Otherwise
      // a rehydrate racing a write reads a stale value it then persists back.
      const queued = pending.get(key)
      return queued ?? (await inner.getItem(key))
    },
    setItem: (key, value) => {
      pending.set(key, value)
      if (!timer) timer = setTimeout(() => void flush(), debounceMs)
      // Resolves immediately. `persist` does not await this, and blocking a
      // store commit on disk IO is what this exists to avoid.
      return Promise.resolve()
    },
    removeItem: async (key) => {
      pending.delete(key)
      await inner.removeItem(key)
    },
    flush,
  }
}
