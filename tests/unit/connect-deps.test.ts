/**
 * connectDeps.waitForHealth: polls a WS health endpoint until it opens or the
 * attempt budget runs out. Exercises the stalled-handshake guard - a tick
 * that fires neither 'open' nor 'error' (TCP connects but the WS upgrade
 * never completes) must still count as a failed attempt and reschedule,
 * instead of hanging the whole probe forever.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

interface Listeners {
  open: Array<() => void>
  error: Array<(err: Error) => void>
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  listeners: Listeners = { open: [], error: [] }
  terminated = false
  closed = false

  constructor(
    public url: string,
    public opts?: { handshakeTimeout?: number },
  ) {
    FakeWebSocket.instances.push(this)
  }

  once(event: 'open' | 'error', cb: (...args: never[]) => void): void {
    ;(this.listeners[event] as Array<(...args: never[]) => void>).push(cb)
  }

  emitOpen(): void {
    this.listeners.open.forEach((cb) => cb())
  }

  emitError(err: Error): void {
    this.listeners.error.forEach((cb) => cb(err))
  }

  close(): void {
    this.closed = true
  }

  terminate(): void {
    this.terminated = true
  }
}

vi.mock('ws', () => ({ default: FakeWebSocket }))

let waitForHealth: typeof import('../../src/main/machines/connectDeps').waitForHealth

beforeEach(async () => {
  vi.useFakeTimers()
  FakeWebSocket.instances = []
  ;({ waitForHealth } = await import('../../src/main/machines/connectDeps'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('waitForHealth', () => {
  it('passes handshakeTimeout so a stalled TCP-only connection cannot hang forever', async () => {
    const promise = waitForHealth('ws://127.0.0.1:1', 30, 1000)
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeWebSocket.instances[0].opts?.handshakeTimeout).toBe(1000)
    FakeWebSocket.instances[0].emitOpen()
    expect(await promise).toBe(true)
  })

  it('a tick that never fires open or error still counts as a failed attempt via the fallback timer, and eventually gives up', async () => {
    const promise = waitForHealth('ws://127.0.0.1:1', 3, 1000)
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeWebSocket.instances).toHaveLength(1)

    // Neither 'open' nor 'error' ever fires on any of these sockets -
    // simulate a stalled WS upgrade repeatedly. Each attempt is a
    // fallback-timeout tick (1000ms) followed by the reconnect delay
    // (1000ms) before the next socket is created.
    await vi.advanceTimersByTimeAsync(6000)

    expect(FakeWebSocket.instances).toHaveLength(3) // capped at `attempts`
    expect(FakeWebSocket.instances.every((ws) => ws.terminated)).toBe(true)
    expect(await promise).toBe(false)
  })

  it('open cancels the fallback timer so it does not double-count as a failure', async () => {
    const promise = waitForHealth('ws://127.0.0.1:1', 3, 1000)
    await vi.advanceTimersByTimeAsync(0)
    FakeWebSocket.instances[0].emitOpen()
    expect(await promise).toBe(true)

    // Advancing past the fallback window must not spawn another tick or
    // otherwise touch the already-resolved promise.
    await vi.advanceTimersByTimeAsync(2000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('a real error cancels the fallback timer so it does not double-count', async () => {
    const promise = waitForHealth('ws://127.0.0.1:1', 1, 1000)
    await vi.advanceTimersByTimeAsync(0)
    FakeWebSocket.instances[0].emitError(new Error('ECONNREFUSED'))
    expect(await promise).toBe(false)
    expect(FakeWebSocket.instances).toHaveLength(1) // attempts budget of 1, no extra tick
  })
})
