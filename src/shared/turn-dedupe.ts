/**
 * Remembers turn origins so a retried send cannot run twice.
 *
 * A client that retries after an ambiguous failure - a socket that died with
 * the request already on the wire, an invoke that timed out - has no way to
 * know whether the backend ran it. Without a check here, the safe client
 * behaviour (retry) produces a duplicate turn, and the safe backend behaviour
 * (run it) makes retrying unsafe. One side has to remember, and it has to be
 * this one.
 *
 * `origin` already existed as a client-minted id used to suppress a client's
 * own echo, so it is reused rather than adding a second id meaning the same
 * thing.
 *
 * Bounded by count and age: a turn is retried within seconds, so nothing older
 * than the window can still be in flight, and an unbounded set on a
 * long-running desktop is a slow leak.
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
   * True when this origin has already been accepted, i.e. the caller should do
   * nothing. Records it otherwise.
   *
   * An absent origin is never a duplicate: older clients do not send one, and
   * treating them all as the same turn would drop every message after the
   * first.
   */
  isDuplicate(origin: string | undefined, nowMs: number = Date.now()): boolean {
    if (!origin) return false
    // Age first, so an entry past the window does not answer "duplicate" for a
    // turn that is legitimately new.
    this.expire(nowMs)
    if (this.seen.has(origin)) return true
    this.seen.set(origin, nowMs)
    // Size after, so the bound holds once this call has returned rather than
    // only until the next insert.
    this.trim()
    return false
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
