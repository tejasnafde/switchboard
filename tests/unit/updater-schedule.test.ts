import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UPDATE_CHECK_INTERVAL_MS,
  shouldRunScheduledCheck,
  startUpdateScheduler,
} from '../../src/main/updater-schedule'

describe('shouldRunScheduledCheck', () => {
  it('runs when nothing is in flight and nothing has downloaded', () => {
    expect(shouldRunScheduledCheck({ checkInFlight: false, downloaded: false })).toBe(true)
  })

  it('skips while a check is already in flight', () => {
    expect(shouldRunScheduledCheck({ checkInFlight: true, downloaded: false })).toBe(false)
  })

  it('skips once an update has downloaded and is waiting for a restart', () => {
    expect(shouldRunScheduledCheck({ checkInFlight: false, downloaded: true })).toBe(false)
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

  function fakeState(overrides: Partial<{ checkInFlight: boolean; downloaded: boolean }> = {}) {
    return { checkInFlight: false, downloaded: false, ...overrides }
  }

  it('fires hourly', () => {
    const runCheck = vi.fn()
    const stop = startUpdateScheduler({
      getState: () => fakeState(),
      runCheck,
      onResume: () => {},
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
      onResume: () => {},
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
      onResume: () => {},
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
      onResume: () => {},
    })

    stop()
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS * 5)
    expect(runCheck).not.toHaveBeenCalled()
  })

  it('unrefs the interval so it cannot keep the process alive on its own', () => {
    const unref = vi.fn()
    const setIntervalFn = vi.fn(() => ({ unref }) as unknown as ReturnType<typeof setInterval>)
    const clearIntervalFn = vi.fn()

    startUpdateScheduler({
      getState: () => fakeState(),
      runCheck: vi.fn(),
      onResume: () => {},
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
      onResume: () => {},
    })

    vi.advanceTimersByTime(999)
    expect(runCheck).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(runCheck).toHaveBeenCalledTimes(1)

    stop()
  })
})
