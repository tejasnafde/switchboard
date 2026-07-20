/**
 * Coalesces PTY output per terminal id so a firehose (verbose build, `cat`
 * of a large file) doesn't emit one host event per pty chunk. node-pty can
 * deliver thousands of chunks per second; each one used to become its own
 * IPC/WS frame (and on the remote path, its own JSON encode + decode).
 *
 * Chunks buffer for up to `flushMs` (default 8ms - well under a frame, so
 * typing echo stays imperceptible) or until `maxBuffered` bytes, whichever
 * comes first, then flush as a single concatenated string. Callers must
 * `flush(id)` before emitting a terminal's EXIT so no tail output is lost.
 */
export class OutputCoalescer {
  private pending = new Map<string, string>()
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(
    private emit: (id: string, data: string) => void,
    private flushMs = 8,
    private maxBuffered = 256 * 1024,
  ) {}

  push(id: string, data: string): void {
    const buffered = (this.pending.get(id) ?? '') + data
    if (buffered.length >= this.maxBuffered) {
      this.pending.delete(id)
      this.clearTimer(id)
      this.emit(id, buffered)
      return
    }
    this.pending.set(id, buffered)
    if (!this.timers.has(id)) {
      this.timers.set(id, setTimeout(() => this.flush(id), this.flushMs))
    }
  }

  /** Flush any buffered output for `id` immediately. */
  flush(id: string): void {
    this.clearTimer(id)
    const data = this.pending.get(id)
    if (data !== undefined) {
      this.pending.delete(id)
      this.emit(id, data)
    }
  }

  /** Flush everything - used when tearing down the pty manager. */
  flushAll(): void {
    for (const id of [...this.pending.keys()]) this.flush(id)
  }

  private clearTimer(id: string): void {
    const t = this.timers.get(id)
    if (t) {
      clearTimeout(t)
      this.timers.delete(id)
    }
  }
}
