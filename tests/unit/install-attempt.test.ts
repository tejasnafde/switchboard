import { describe, it, expect, vi } from 'vitest'
import { InstallAttempt } from '../../src/main/install-attempt'
import { QuitCoordinator } from '../../src/main/quit-coordinator'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => { resolve = res })
  return { promise, resolve }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function setup(teardown: () => Promise<void>) {
  const coordinator = new QuitCoordinator(teardown, vi.fn(), (cb) => cb())
  const timers: Array<() => void> = []
  const attempt = new InstallAttempt(coordinator, 15_000, (cb) => { timers.push(cb) })
  const callbacks = { install: vi.fn(), onAborted: vi.fn(), onRecovered: vi.fn() }
  return { coordinator, timers, attempt, callbacks }
}

describe('InstallAttempt', () => {
  it('installs once teardown finishes, and drops repeat clicks', async () => {
    const { attempt, callbacks } = setup(async () => {})

    expect(attempt.start(callbacks)).toBe(true)
    expect(attempt.start(callbacks)).toBe(false)
    await flush()
    expect(callbacks.install).toHaveBeenCalledTimes(1)
  })

  it('recovers at once when the install did not take', async () => {
    const teardown = vi.fn(async () => {})
    const { coordinator, timers, attempt, callbacks } = setup(teardown)

    attempt.start(callbacks)
    await flush()
    timers[0]()
    expect(callbacks.onAborted).toHaveBeenCalledTimes(1)
    expect(callbacks.onRecovered).toHaveBeenCalledTimes(1)
    expect(coordinator.isQuitting).toBe(false)

    // The next quit tears down again, and a retry is accepted.
    expect(coordinator.handleBeforeQuit()).toBe(true)
    expect(teardown).toHaveBeenCalledTimes(2)
    expect(attempt.start(callbacks)).toBe(true)
  })

  it('waits for a teardown still running at the timeout, and never installs late', async () => {
    const d = deferred()
    const { coordinator, timers, attempt, callbacks } = setup(() => d.promise)

    attempt.start(callbacks)
    timers[0]()
    expect(callbacks.onAborted).toHaveBeenCalledTimes(1)
    await flush()
    expect(callbacks.onRecovered).not.toHaveBeenCalled()
    expect(coordinator.isQuitting).toBe(true)
    // Recovery is pending: a retry now would race it.
    expect(attempt.start(callbacks)).toBe(false)

    d.resolve()
    await flush()
    expect(callbacks.install).not.toHaveBeenCalled()
    expect(callbacks.onRecovered).toHaveBeenCalledTimes(1)
    expect(coordinator.isQuitting).toBe(false)
    expect(attempt.start(callbacks)).toBe(true)
  })
})
