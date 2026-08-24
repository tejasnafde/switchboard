import { describe, it, expect, vi } from 'vitest'
import { QuitCoordinator } from '../../src/main/quit-coordinator'

/**
 * QuitCoordinator serialises app teardown so quit runs exactly one async
 * teardown pass (PTY drain, provider stop, db close) before the process
 * actually exits. Two entry points:
 *
 * - handleBeforeQuit(): called from `app.on('before-quit')`. Returns true
 *   when the caller must preventDefault (teardown still pending); the
 *   coordinator re-requests quit once teardown finishes.
 * - prepare(): called by the updater path BEFORE autoUpdater.quitAndInstall()
 *   so the later before-quit passes straight through with no preventDefault
 *   (Squirrel's install flow must not be interrupted).
 */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('QuitCoordinator', () => {
  it('exposes teardown as a one-way quitting lifecycle', () => {
    const coord = new QuitCoordinator(() => new Promise(() => {}), vi.fn())

    expect(coord.isQuitting).toBe(false)
    coord.handleBeforeQuit()
    expect(coord.isQuitting).toBe(true)
  })

  it('prevents the first quit and starts teardown', () => {
    const d = deferred()
    const teardown = vi.fn(() => d.promise)
    const requestQuit = vi.fn()
    const coord = new QuitCoordinator(teardown, requestQuit)

    expect(coord.handleBeforeQuit()).toBe(true)
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(requestQuit).not.toHaveBeenCalled()
  })

  it('re-requests quit after teardown resolves on a fresh turn, then lets it pass', async () => {
    const d = deferred()
    const requestQuit = vi.fn()
    const coord = new QuitCoordinator(() => d.promise, requestQuit)

    coord.handleBeforeQuit()
    d.resolve()
    await d.promise
    await Promise.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    expect(requestQuit).toHaveBeenCalledTimes(1)
    expect(coord.handleBeforeQuit()).toBe(false)
  })

  it('defers exactly one quit retry to a fresh event-loop turn', async () => {
    const d = deferred()
    const requestQuit = vi.fn()
    const scheduled: Array<() => void> = []
    const coord = new QuitCoordinator(
      () => d.promise,
      requestQuit,
      (callback) => scheduled.push(callback),
    )

    coord.handleBeforeQuit()
    coord.handleBeforeQuit()
    d.resolve()
    await d.promise
    await Promise.resolve()

    expect(requestQuit).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)
    scheduled[0]()
    expect(requestQuit).toHaveBeenCalledTimes(1)
  })

  it('runs teardown only once across repeated quit events', async () => {
    const d = deferred()
    const teardown = vi.fn(() => d.promise)
    const coord = new QuitCoordinator(teardown, vi.fn())

    expect(coord.handleBeforeQuit()).toBe(true)
    expect(coord.handleBeforeQuit()).toBe(true)
    expect(teardown).toHaveBeenCalledTimes(1)
  })

  it('prepare() awaits teardown and marks quit free to pass', async () => {
    const d = deferred()
    const requestQuit = vi.fn()
    const coord = new QuitCoordinator(() => d.promise, requestQuit)

    const prep = coord.prepare()
    d.resolve()
    await prep
    // updater path: the caller triggers its own quit, so the coordinator
    // must NOT fire requestQuit here
    expect(requestQuit).not.toHaveBeenCalled()
    expect(coord.handleBeforeQuit()).toBe(false)
  })

  it('prepare() is idempotent and shares one teardown', async () => {
    const d = deferred()
    const teardown = vi.fn(() => d.promise)
    const coord = new QuitCoordinator(teardown, vi.fn())

    const p1 = coord.prepare()
    const p2 = coord.prepare()
    d.resolve()
    await Promise.all([p1, p2])
    expect(teardown).toHaveBeenCalledTimes(1)
  })

  it('a rejected teardown still completes the quit', async () => {
    const d = deferred()
    const requestQuit = vi.fn()
    const coord = new QuitCoordinator(() => d.promise, requestQuit)

    coord.handleBeforeQuit()
    d.reject(new Error('db close failed'))
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    expect(requestQuit).toHaveBeenCalledTimes(1)
    expect(coord.handleBeforeQuit()).toBe(false)
  })
})
