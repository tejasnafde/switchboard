/**
 * Tracks in-flight pty exits. `pty.kill()` returns before node-pty delivers
 * the exit callback via napi ThreadSafeFunction, and a callback that lands
 * after the Node environment starts tearing down aborts the process (SIGABRT
 * in pty.node, the 0.7.28 restart-and-install crash). Quit waits on this.
 */
export type DrainResult = 'drained' | 'timed-out'

export class ExitDrain {
  private pending = new Set<string>()
  private waiters: Array<() => void> = []

  get pendingCount(): number {
    return this.pending.size
  }

  /** Register a pty whose exit callback has not fired yet. */
  track(id: string): void {
    this.pending.add(id)
  }

  /** Mark a pty's exit callback as delivered. Unknown ids are a no-op. */
  settle(id: string): void {
    if (!this.pending.delete(id)) return
    if (this.pending.size === 0) {
      const waiters = this.waiters
      this.waiters = []
      for (const resolve of waiters) resolve()
    }
  }

  /**
   * Resolve 'drained' once every tracked exit has settled, or 'timed-out'
   * after `timeoutMs` so a hung process cannot block quit forever.
   */
  wait(timeoutMs: number): Promise<DrainResult> {
    if (this.pending.size === 0) return Promise.resolve('drained')
    return new Promise<DrainResult>((resolve) => {
      const timer = setTimeout(() => resolve('timed-out'), timeoutMs)
      this.waiters.push(() => {
        clearTimeout(timer)
        resolve('drained')
      })
    })
  }
}
