import type { QuitCoordinator } from './quit-coordinator'

export interface InstallAttemptCallbacks {
  /** Hands the process to the updater; returns if the install never took. */
  install: () => void
  /** The install has not replaced the process in time. */
  onAborted: () => void
  /** Teardown has settled and the coordinator is rearmed: bring services back. */
  onRecovered: () => void
}

/**
 * Restart-and-install: tear down, hand over to the updater, and recover if the
 * process is still here after `timeoutMs`. No electron import, so it stays
 * unit-testable.
 *
 * The watchdog can fire while teardown is still draining. That attempt is then
 * abandoned: the install never starts late, and recovery waits for the drain
 * before rearming, so it never reopens the database under a running teardown.
 * New attempts are refused until recovery has run.
 */
export class InstallAttempt {
  private busy = false

  constructor(
    private readonly coordinator: Pick<QuitCoordinator, 'prepare' | 'rearmWhenSettled'>,
    private readonly timeoutMs = 15_000,
    private readonly setTimer: (callback: () => void, ms: number) => void = (callback, ms) => {
      setTimeout(callback, ms)
    },
  ) {}

  /** False when an attempt (or its recovery) is already in progress. */
  start(callbacks: InstallAttemptCallbacks): boolean {
    if (this.busy) return false
    this.busy = true
    let abandoned = false
    // prepare(), not a bare teardown: it marks quit as already drained, so
    // before-quit won't preventDefault the quit the updater fires.
    void this.coordinator.prepare().then(() => {
      if (!abandoned) callbacks.install()
    })
    this.setTimer(() => {
      abandoned = true
      callbacks.onAborted()
      void this.coordinator.rearmWhenSettled(() => {
        this.busy = false
        callbacks.onRecovered()
      })
    }, this.timeoutMs)
    return true
  }
}
