/**
 * Bounded ring of recent `evt` frames, so a reconnecting client can ask for
 * everything after the last sequence it saw.
 *
 * Bounded two ways: a count cap alone lets one huge frame pin megabytes, a byte
 * cap alone lets tiny frames grow the array. Whichever binds first wins.
 *
 * Eviction is reported rather than silent - once the oldest retained sequence
 * passes a cursor, `since()` says `gap` and the caller re-seeds.
 */

/** Generous: a phone backgrounded for minutes should still resume cleanly, and
 *  terminal output does not enter this buffer. */
export const DEFAULT_MAX_FRAMES = 2_000
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

export interface ReplayResult {
  /** Frames with seq > the cursor, oldest first. */
  frames: string[]
  /** The cursor predates what is retained, so `frames` is incomplete. */
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
    this.entries.push({ seq, encoded, bytes })
    this.bytes += bytes
    // `length > 1` stops a frame larger than the whole budget from emptying the
    // buffer and still not fitting.
    while (this.entries.length > this.maxFrames || (this.bytes > this.maxBytes && this.entries.length > 1)) {
      const evicted = this.entries.shift()
      if (!evicted) break
      this.bytes -= evicted.bytes
    }
  }

  /** Frames after `cursor`. */
  since(cursor: number): ReplayResult {
    if (this.entries.length === 0) {
      return { frames: [], gap: false }
    }
    // Nothing was evicted if the oldest frame we hold is the next one after
    // their cursor, or earlier.
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
