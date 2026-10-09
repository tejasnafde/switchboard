/**
 * Scheduling rule for periodic + resume-triggered update checks. Kept
 * separate from `updater.ts` so the decision logic and the timer wiring are
 * unit-testable with fake timers, without mocking electron-updater or
 * electron itself.
 *
 * A desktop app can run for days between launches, and `registerAutoUpdater`
 * otherwise only ever checks once, 3s after launch. This adds an hourly
 * check plus a check on waking from sleep, both routed through the same
 * `shouldRunScheduledCheck` gate so they never pile onto a check already in
 * flight or re-check once an update is sitting downloaded and waiting for a
 * restart.
 */

export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

export interface UpdateScheduleState {
  /** A checkForUpdates() call (manual, initial, or scheduled) is in flight. */
  checkInFlight: boolean
  /** An update has already downloaded and is waiting on the user to restart. */
  downloaded: boolean
}

export type ScheduledCheckReason = 'interval' | 'resume'

/**
 * Pure: should a periodic or resume-triggered check run right now? Skips
 * while a check is already in flight (electron-updater dedups concurrent
 * checks anyway, so this just avoids the noise of trying) and once an
 * update has downloaded, since there is nothing newer to find until the
 * user installs it, and a background check must not overwrite the
 * "downloaded, restart to update" status the renderer is showing.
 */
export function shouldRunScheduledCheck(state: UpdateScheduleState): boolean {
  return !state.checkInFlight && !state.downloaded
}

export interface UpdateSchedulerDeps {
  intervalMs?: number
  getState: () => UpdateScheduleState
  runCheck: (reason: ScheduledCheckReason) => void
  /** Registers a listener for the system waking from sleep; returns a function that removes it. */
  onResume: (listener: () => void) => () => void
  setIntervalFn?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void
}

/**
 * Wires `shouldRunScheduledCheck` to a repeating timer and a resume event
 * source. Returns a stop function that clears the timer AND removes the
 * resume listener - call it on quit so the scheduler can neither keep the
 * process alive, fire mid-shutdown, nor (if the scheduler is later
 * restarted, see `resumeAutoUpdaterScheduler`) leave a stale listener that
 * keeps answering `resume` after it was told to stop. The timer is also
 * unref'd as a backstop for a caller that forgets to stop it: an unref'd
 * interval never by itself keeps the event loop alive.
 */
export function startUpdateScheduler(deps: UpdateSchedulerDeps): () => void {
  const intervalMs = deps.intervalMs ?? UPDATE_CHECK_INTERVAL_MS
  const setIntervalFn = deps.setIntervalFn ?? setInterval
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval

  const tick = (reason: ScheduledCheckReason): void => {
    if (!shouldRunScheduledCheck(deps.getState())) return
    deps.runCheck(reason)
  }

  const timer = setIntervalFn(() => tick('interval'), intervalMs)
  const unrefable = timer as unknown as { unref?: () => void }
  if (typeof unrefable.unref === 'function') unrefable.unref()

  const removeResumeListener = deps.onResume(() => tick('resume'))

  return () => {
    clearIntervalFn(timer)
    removeResumeListener()
  }
}
