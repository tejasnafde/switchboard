/**
 * A zustand `persist` storage that writes at most once per window.
 *
 * The chat store commits a batch every 50ms while an agent streams and
 * `persist` writes on every commit. This coalesces the DISK WRITE; `partialize`
 * and `JSON.stringify` still run per commit, above this layer.
 *
 * Losing the last window on a hard kill is the trade. This caches something the
 * backend still owns; user intent lives in the outbox, which writes immediately.
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
