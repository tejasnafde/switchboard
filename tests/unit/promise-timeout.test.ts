/**
 * `withTimeout` - race a promise against a deadline. Extracted from
 * codex-adapter's private copy so the updater can reuse it: a hung
 * `autoUpdater.checkForUpdates()` HTTP request left the Settings row on
 * "Checking..." forever (seen 2026-08-07, log shows a check that never
 * resolved and an "already in progress" refusal on the retry click).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { withTimeout } from '../../src/shared/promise-timeout'

afterEach(() => {
  vi.useRealTimers()
})

describe('withTimeout', () => {
  it('resolves with the value when the promise settles before the deadline', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'op')).resolves.toBe('ok')
  })

  it('rejects with the original error when the promise rejects before the deadline', async () => {
    const boom = new Error('boom')
    await expect(withTimeout(Promise.reject(boom), 1000, 'op')).rejects.toBe(boom)
  })

  it('rejects naming the operation and deadline when nothing settles in time', async () => {
    vi.useFakeTimers()
    const never = new Promise(() => {})
    const raced = withTimeout(never, 30_000, 'Update check')
    // Attach the rejection expectation BEFORE advancing the clock so the
    // rejection is never unhandled.
    const assertion = expect(raced).rejects.toThrow('Update check timed out after 30000ms')
    await vi.advanceTimersByTimeAsync(30_000)
    await assertion
  })

  it('does not reject late when the promise settled first', async () => {
    vi.useFakeTimers()
    const raced = withTimeout(Promise.resolve('fast'), 30_000, 'op')
    await expect(raced).resolves.toBe('fast')
    // Advancing past the deadline must not produce an unhandled rejection
    // from a timer that should have been cleared.
    await vi.advanceTimersByTimeAsync(60_000)
  })
})
