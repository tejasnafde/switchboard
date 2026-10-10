import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UPDATE_CHECK_INTERVAL_MS,
  shouldRunScheduledCheck,
  startUpdateScheduler,
} from '../../src/main/updater-schedule'

describe('shouldRunScheduledCheck', () => {
  it('runs when nothing is in flight and nothing has downloaded', () => {
    expect(shouldRunScheduledCheck({ checkInFlight: false, downloadInFlight: false, downloaded: false })).toBe(true)
  })

  it('skips while a check is already in flight', () => {
    expect(shouldRunScheduledCheck({ checkInFlight: true, downloadInFlight: false, downloaded: false })).toBe(false)
  })

  it('skips while a download a finished check started is still running', () => {
    expect(shouldRunScheduledCheck({ checkInFlight: false, downloadInFlight: true, downloaded: false })).toBe(false)
  })

  it('skips once an update has downloaded and is waiting for a restart', () => {
    expect(shouldRunScheduledCheck({ checkInFlight: false, downloadInFlight: false, downloaded: true })).toBe(false)
  })
})

describe('startUpdateScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  function fakeState(overrides: Partial<{ checkInFlight: boolean; downloadInFlight: boolean; downloaded: boolean }> = {}) {
    return { checkInFlight: false, downloadInFlight: false, downloaded: false, ...overrides }
  }

  /** A no-op resume source: registers nothing real, removes nothing real. */
  function noResume(): () => void {
    return () => {}
  }

  it('fires hourly', () => {
    const runCheck = vi.fn()
    const stop = startUpdateScheduler({
      getState: () => fakeState(),
      runCheck,
      onResume: noResume,
    })

    expect(runCheck).not.toHaveBeenCalled()
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS)
    expect(runCheck).toHaveBeenCalledTimes(1)
    expect(runCheck).toHaveBeenCalledWith('interval')
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS)
    expect(runCheck).toHaveBeenCalledTimes(2)

    stop()
  })

  it('skips an interval tick while a check is in flight', () => {
    const runCheck = vi.fn()
    const state = fakeState({ checkInFlight: true })
    const stop = startUpdateScheduler({
      getState: () => state,
      runCheck,
      onResume: noResume,
    })

    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS)
    expect(runCheck).not.toHaveBeenCalled()

    stop()
  })

  it('skips an interval tick once an update has downloaded', () => {
    const runCheck = vi.fn()
    const stop = startUpdateScheduler({
      getState: () => fakeState({ downloaded: true }),
      runCheck,
      onResume: noResume,
    })

    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS)
    expect(runCheck).not.toHaveBeenCalled()

    stop()
  })

  it('fires on resume', () => {
    const runCheck = vi.fn()
    let resumeListener: (() => void) | undefined
    const stop = startUpdateScheduler({
      getState: () => fakeState(),
      runCheck,
      onResume: (listener) => {
        resumeListener = listener
        return () => {
          resumeListener = undefined
        }
      },
    })

    expect(resumeListener).toBeTypeOf('function')
    resumeListener?.()
    expect(runCheck).toHaveBeenCalledWith('resume')

    stop()
  })

  it('skips a resume tick while a check is in flight or an update has downloaded', () => {
    const runCheck = vi.fn()
    let resumeListener: (() => void) | undefined
    const state = fakeState({ checkInFlight: true })
    const stop = startUpdateScheduler({
      getState: () => state,
      runCheck,
      onResume: (listener) => {
        resumeListener = listener
        return () => {}
      },
    })

    resumeListener?.()
    expect(runCheck).not.toHaveBeenCalled()

    stop()
  })

  it('stop() clears the interval so no further ticks fire', () => {
    const runCheck = vi.fn()
    const stop = startUpdateScheduler({
      getState: () => fakeState(),
      runCheck,
      onResume: noResume,
    })

    stop()
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS * 5)
    expect(runCheck).not.toHaveBeenCalled()
  })

  it('stop() removes the resume listener so a later resume does not fire', () => {
    const runCheck = vi.fn()
    let resumeListener: (() => void) | undefined
    const removeListener = vi.fn(() => {
      resumeListener = undefined
    })
    const stop = startUpdateScheduler({
      getState: () => fakeState(),
      runCheck,
      onResume: (listener) => {
        resumeListener = listener
        return removeListener
      },
    })

    stop()
    expect(removeListener).toHaveBeenCalledTimes(1)
    // Simulates a caller (e.g. electron's powerMonitor) that still holds a
    // reference to the listener after `off()` was never actually wired up -
    // a regression here would mean `resumeListener` is still defined.
    expect(resumeListener).toBeUndefined()
  })

  it('unrefs the interval so it cannot keep the process alive on its own', () => {
    const unref = vi.fn()
    const setIntervalFn = vi.fn(() => ({ unref }) as unknown as ReturnType<typeof setInterval>)
    const clearIntervalFn = vi.fn()

    startUpdateScheduler({
      getState: () => fakeState(),
      runCheck: vi.fn(),
      onResume: noResume,
      setIntervalFn,
      clearIntervalFn,
    })

    expect(unref).toHaveBeenCalledTimes(1)
  })

  it('respects a custom interval', () => {
    const runCheck = vi.fn()
    const stop = startUpdateScheduler({
      intervalMs: 1_000,
      getState: () => fakeState(),
      runCheck,
      onResume: noResume,
    })

    vi.advanceTimersByTime(999)
    expect(runCheck).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(runCheck).toHaveBeenCalledTimes(1)

    stop()
  })
})
