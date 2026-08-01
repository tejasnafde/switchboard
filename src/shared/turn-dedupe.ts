/**
 * Remembers turn origins so a retried send cannot run twice.
 *
 * A client retrying an ambiguous failure cannot know whether the backend ran
 * it. Without a check here the safe client behaviour produces a duplicate turn,
 * and the safe backend behaviour makes retrying unsafe. Reuses the existing
 * client-minted `origin` rather than adding a second id meaning the same thing.
 *
 * Bounded by count and age: nothing older than the window can still be in
 * flight, and an unbounded set on a long-running desktop is a slow leak.
 */

export const DEDUPE_MAX_AGE_MS = 10 * 60_000
export const DEDUPE_MAX_ENTRIES = 500

export class TurnDeduper {
  private readonly seen = new Map<string, number>()

  constructor(
    private readonly maxAgeMs = DEDUPE_MAX_AGE_MS,
    private readonly maxEntries = DEDUPE_MAX_ENTRIES,
  ) {}

  /**
   * True when this origin was already accepted; records it otherwise.
   *
   * An absent origin is never a duplicate - older clients send none, and
   * collapsing them onto one key would drop every message after the first.
   */
  isDuplicate(origin: string | undefined, nowMs: number = Date.now()): boolean {
    if (!origin) return false
    this.expire(nowMs) // age first, so a stale entry cannot answer "duplicate"
    if (this.seen.has(origin)) return true
    this.seen.set(origin, nowMs)
    this.trim() // size after, so the bound holds once this call has returned
    return false
  }

  /** Forget an origin whose operation failed. Recording on entry is what makes
   *  the check race-free, but without this a failed turn stays claimed and the
   *  client's legitimate retry is answered as a duplicate and dropped. */
  release(origin: string | undefined): void {
    if (origin) this.seen.delete(origin)
  }

  private expire(nowMs: number): void {
    for (const [origin, at] of this.seen) {
      if (nowMs - at > this.maxAgeMs) this.seen.delete(origin)
    }
  }

  private trim(): void {
    // Insertion order is oldest first, so this drops the least recent.
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value
      if (oldest === undefined) break
      this.seen.delete(oldest)
    }
  }

  get size(): number {
    return this.seen.size
  }
}
