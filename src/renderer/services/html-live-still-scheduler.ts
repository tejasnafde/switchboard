/**
 * Hidden still captures for ```html-live frames that never ran in view.
 *
 * A frame that has no still image (in this window or on the chat's backend)
 * and is not in view asks for a hidden capture: it renders its page out of
 * sight, waits for it to settle, captures it and tears it down. Hidden
 * captures share the running limit with the frames that run in view, and the
 * frames in view always come first: a capture takes only a slot they leave
 * free, oldest request first, and the rest wait in the queue. One capture
 * runs per page key; a key is never captured twice in a window.
 *
 * No DOM and no React here, so the rules are unit-tested directly.
 */
import { HTML_LIVE_MAX_RUNNING } from '@shared/html-live'

/** What a frame knows when it decides whether to ask for a hidden capture. */
export interface HtmlLiveStillFacts {
  /** The page key, `null` while it is hashed. */
  key: string | null
  /** The key whose backend state has loaded (its image, if any, is then known). */
  loadedKey: string | null
  hasImage: boolean
  /** The block passes `htmlLiveVerdict` (size, libraries). */
  allowed: boolean
  inPane: boolean
  saved: boolean
  /** `null` until the block was first observed. */
  inView: boolean | null
  running: boolean
}

/**
 * The page key to capture hidden, or `null`: only a closed block the running
 * rule would let run (allowed, not in the pane, not saved) with no still image
 * in this window or on the backend, that is known not to be in view and is
 * not running.
 */
export function hiddenStillKey(facts: HtmlLiveStillFacts): string | null {
  const { key } = facts
  if (key === null || facts.loadedKey !== key || facts.hasImage) return null
  if (!facts.allowed || facts.inPane || facts.saved) return null
  if (facts.inView !== false || facts.running) return null
  return key
}

export interface HtmlLiveStillRequest {
  id: string
  /** The page key (hex SHA-256 of the block source). */
  key: string
  /** Request order: a lower number was asked first. */
  seq: number
}

/**
 * The frames that render hidden now: the oldest requests, one per key, for
 * keys not done, in the slots the running frames leave free.
 */
export function pickHiddenCaptures(
  requests: readonly HtmlLiveStillRequest[],
  running: ReadonlySet<string>,
  doneKeys: ReadonlySet<string>,
  limit = HTML_LIVE_MAX_RUNNING,
): Set<string> {
  const slots = limit - running.size
  const picked = new Set<string>()
  if (slots <= 0) return picked
  const keys = new Set<string>()
  for (const request of [...requests].sort((a, b) => a.seq - b.seq)) {
    if (picked.size >= slots) break
    if (running.has(request.id) || doneKeys.has(request.key) || keys.has(request.key)) continue
    keys.add(request.key)
    picked.add(request.id)
  }
  return picked
}

export interface HtmlLiveStillScheduler {
  /** The frame may take a hidden capture of `key`. A repeat call keeps its place in the queue. Returns whether anything changed. */
  request(id: string, key: string): boolean
  /** The frame unmounted, came into view or may no longer run: drop its request. Returns whether anything changed. */
  cancel(id: string): boolean
  /** The capture of `key` ended (with or without an image): no frame captures it again. */
  finish(id: string, key: string): void
  /** The key has a still image from elsewhere (a frame in view, the backend). */
  markDone(key: string): void
  pick(running: ReadonlySet<string>): Set<string>
}

export function createStillScheduler(limit = HTML_LIVE_MAX_RUNNING): HtmlLiveStillScheduler {
  const requests = new Map<string, HtmlLiveStillRequest>()
  const doneKeys = new Set<string>()
  let seq = 0
  return {
    request(id, key) {
      if (doneKeys.has(key) || requests.get(id)?.key === key) return false
      requests.set(id, { id, key, seq: ++seq })
      return true
    },
    cancel(id) {
      return requests.delete(id)
    },
    finish(id, key) {
      requests.delete(id)
      doneKeys.add(key)
    },
    markDone(key) {
      doneKeys.add(key)
    },
    pick(running) {
      return pickHiddenCaptures([...requests.values()], running, doneKeys, limit)
    },
  }
}
