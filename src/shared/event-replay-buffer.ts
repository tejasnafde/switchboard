/**
 * Bounded ring of recently emitted `evt` frames, so a client that reconnects
 * can ask for everything after the last sequence it saw instead of losing it.
 *
 * Bounded two ways on purpose. A count cap alone lets one enormous frame (a
 * big tool result) pin megabytes; a byte cap alone lets a flood of tiny frames
 * grow the array without limit. Whichever binds first wins.
 *
 * Eviction is honest rather than silent: once the oldest retained sequence has
 * passed a requester's cursor, `since()` reports `gap`, and the caller re-seeds
 * instead of stitching a transcript that is quietly missing turns.
 */

/** Deliberately generous - a phone backgrounded for a few minutes should still
 *  resume cleanly, and provider events are small. Terminal output does not
 *  enter this buffer (see NON_REPLAYABLE_EVENT_CHANNELS). */
export const DEFAULT_MAX_FRAMES = 2_000
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

export interface ReplayResult {
  /** Encoded frames with seq > the requested cursor, oldest first. */
  frames: string[]
  /** True when the cursor predates what is still retained, so `frames` is
   *  known-incomplete and the caller must re-seed from scratch. */
  gap: boolean
}

interface Entry {
  seq: number
  encoded: string
  bytes: number
}

export class EventReplayBuffer {
  private readonly entries: Entry[] = []
  private bytes = 0

  constructor(
    private readonly maxFrames = DEFAULT_MAX_FRAMES,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
  ) {}

  /** Sequence of the newest retained frame, or 0 when empty. */
  get latestSeq(): number {
    return this.entries.length === 0 ? 0 : this.entries[this.entries.length - 1]!.seq
  }

  /** Sequence of the oldest retained frame, or 0 when empty. */
  get oldestSeq(): number {
    return this.entries.length === 0 ? 0 : this.entries[0]!.seq
  }

  get size(): number {
    return this.entries.length
  }

  push(seq: number, encoded: string): void {
    const bytes = encoded.length
    // A single frame larger than the whole budget would evict everything and
    // then still not fit. Retain it alone rather than emptying the buffer for
    // nothing: the next push trims it away normally.
    this.entries.push({ seq, encoded, bytes })
    this.bytes += bytes
    while (this.entries.length > this.maxFrames || (this.bytes > this.maxBytes && this.entries.length > 1)) {
      const evicted = this.entries.shift()
      if (!evicted) break
      this.bytes -= evicted.bytes
    }
  }

  /**
   * Frames after `cursor`. A cursor of 0 means "I have nothing", which is not
   * a gap on a fresh server but is one as soon as anything has been evicted.
   */
  since(cursor: number): ReplayResult {
    if (this.entries.length === 0) {
      return { frames: [], gap: false }
    }
    // Everything the caller missed is still retained when the oldest frame we
    // hold is the very next one after their cursor (or earlier).
    const gap = cursor + 1 < this.oldestSeq
    const frames: string[] = []
    for (const entry of this.entries) {
      if (entry.seq > cursor) frames.push(entry.encoded)
    }
    return { frames, gap }
  }

  clear(): void {
    this.entries.length = 0
    this.bytes = 0
  }
}
