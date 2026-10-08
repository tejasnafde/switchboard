/**
 * Runs app teardown (PTY drain, provider stop, db close) exactly once before
 * the process exits. `handleBeforeQuit()` reports whether the caller must
 * preventDefault; `prepare()` pre-drains so the updater's own quit passes
 * straight through. No electron import, so it stays unit-testable.
 */
export class QuitCoordinator {
  private drain: Promise<void> | null = null
  private done = false
  private quitRequestScheduled = false

  constructor(
    private readonly teardown: () => Promise<void>,
    private readonly requestQuit: () => void,
    private readonly schedule: (callback: () => void) => void = (callback) => {
      setImmediate(callback)
    },
  ) {}

  get isQuitting(): boolean {
    return this.drain !== null
  }

  private startDrain(): Promise<void> {
    if (!this.drain) {
      // Start teardown synchronously so quit work begins inside the
      // before-quit tick. A throwing or rejecting teardown must never
      // block quit.
      let run: Promise<void>
      try {
        run = this.teardown()
      } catch {
        run = Promise.resolve()
      }
      const onDone = (): void => {
        this.done = true
      }
      this.drain = run.then(onDone, onDone)
    }
    return this.drain
  }

  /** Returns true when the quit event must be prevented (teardown pending). */
  handleBeforeQuit(): boolean {
    if (this.done) return false
    const drain = this.startDrain()
    if (!this.quitRequestScheduled) {
      this.quitRequestScheduled = true
      void drain.then(() => this.schedule(this.requestQuit))
    }
    return true
  }

  /** Run teardown now; afterwards quit passes through un-prevented. */
  prepare(): Promise<void> {
    return this.startDrain()
  }

  /**
   * The quit never happened (an update install that did not start): the next
   * quit tears down again. Refused while a teardown is still running.
   */
  rearm(): boolean {
    if (this.drain && !this.done) return false
    this.drain = null
    this.done = false
    this.quitRequestScheduled = false
    return true
  }

  /**
   * rearm() now if no teardown is running, otherwise once it settles; then
   * onRearmed. A drain never rejects, so the wait always ends.
   */
  async rearmWhenSettled(onRearmed: () => void): Promise<void> {
    if (!this.rearm()) {
      await this.drain
      if (!this.rearm()) return
    }
    onRearmed()
  }
}
