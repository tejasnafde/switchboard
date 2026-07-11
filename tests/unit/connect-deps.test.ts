/**
 * connectDeps.waitForHealth: polls a WS health endpoint until it opens AND
 * answers a `server:version` request with a version matching this build, or
 * the attempt budget runs out. Covers:
 *  - stalled handshake (TCP connects but the WS upgrade never completes)
 *  - stalled version response (WS opens but nothing ever answers - a truly
 *    ancient server with no request/response dispatch at all)
 *  - version mismatch / an error response (old server, no handler for the
 *    channel) - both must count as unhealthy, not pass the probe
 *
 * Also covers REMOTE_COMMAND: it must kill a lingering server (tracked via
 * pidfile) before launching a fresh one, so a process left over from an
 * ungraceful tunnel drop can't keep holding the port.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServer, type AddressInfo } from 'node:net'

interface Listeners {
  open: Array<() => void>
  error: Array<(err: Error) => void>
  message: Array<(data: { toString(): string }) => void>
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  listeners: Listeners = { open: [], error: [], message: [] }
  terminated = false
  closed = false
  sent: string[] = []

  constructor(
    public url: string,
    public opts?: { handshakeTimeout?: number },
  ) {
    FakeWebSocket.instances.push(this)
  }

  once(event: 'open' | 'error' | 'message', cb: (...args: never[]) => void): void {
    ;(this.listeners[event] as Array<(...args: never[]) => void>).push(cb)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  emitOpen(): void {
    this.listeners.open.forEach((cb) => cb())
  }

  emitError(err: Error): void {
    this.listeners.error.forEach((cb) => cb(err))
  }

  emitMessage(payload: unknown): void {
    const data = { toString: () => JSON.stringify(payload) }
    this.listeners.message.forEach((cb) => cb(data as never))
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
let spawnTunnel: typeof import('../../src/main/machines/connectDeps').spawnTunnel
let allocatePort: typeof import('../../src/main/machines/connectDeps').allocatePort
let REMOTE_COMMAND: typeof import('../../src/main/machines/connectDeps').REMOTE_COMMAND
let SERVER_VERSION_CHANNEL: typeof import('../../src/main/machines/connectDeps').SERVER_VERSION_CHANNEL

const LOCAL_VERSION = '1.2.3'

beforeEach(async () => {
  vi.useFakeTimers()
  FakeWebSocket.instances = []
  process.env.npm_package_version = LOCAL_VERSION
  ;({ waitForHealth, spawnTunnel, allocatePort, REMOTE_COMMAND, SERVER_VERSION_CHANNEL } = await import('../../src/main/machines/connectDeps'))
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.npm_package_version
})

describe('waitForHealth', () => {
  it('passes handshakeTimeout so a stalled TCP-only connection cannot hang forever', async () => {
    const promise = waitForHealth('ws://127.0.0.1:1', 30, 1000)
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeWebSocket.instances[0].opts?.handshakeTimeout).toBe(1000)
    FakeWebSocket.instances[0].emitOpen()
    FakeWebSocket.instances[0].emitMessage({ k: 'res', id: 1, ok: true, result: LOCAL_VERSION })
    expect(await promise).toEqual({ ok: true })
  })

  it('sends a server:version request once the socket opens', async () => {
    const promise = waitForHealth('ws://127.0.0.1:1', 1, 1000)
    await vi.advanceTimersByTimeAsync(0)
    FakeWebSocket.instances[0].emitOpen()
    expect(FakeWebSocket.instances[0].sent).toHaveLength(1)
    expect(JSON.parse(FakeWebSocket.instances[0].sent[0])).toEqual({
      k: 'req',
      id: 1,
      ch: SERVER_VERSION_CHANNEL,
      args: [],
    })
    FakeWebSocket.instances[0].emitMessage({ k: 'res', id: 1, ok: true, result: LOCAL_VERSION })
    expect(await promise).toEqual({ ok: true })
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
    expect(await promise).toEqual({ ok: false, reason: 'handshake stalled' })
  })

  it('open with no version response ever arriving still counts as a failed attempt (silence is not healthy)', async () => {
    const promise = waitForHealth('ws://127.0.0.1:1', 2, 1000)
    await vi.advanceTimersByTimeAsync(0)
    FakeWebSocket.instances[0].emitOpen()

    // Open resets the fallback for the version response (fires at +1000ms),
    // which schedules a second attempt (+1000ms reconnect delay) whose own
    // socket never opens either, so its handshake fallback (+1000ms) is what
    // finally exhausts the attempt budget.
    await vi.advanceTimersByTimeAsync(3000)

    expect(FakeWebSocket.instances).toHaveLength(2) // capped at `attempts`
    // Attempt 1's version response times out; attempt 2's socket never opens,
    // so the last recorded reason is its handshake stall.
    expect(await promise).toEqual({ ok: false, reason: 'handshake stalled' })
  })

  it('a version mismatch counts as a failed attempt, not healthy', async () => {
    const promise = waitForHealth('ws://127.0.0.1:1', 2, 1000)
    await vi.advanceTimersByTimeAsync(0)
    FakeWebSocket.instances[0].emitOpen()
    FakeWebSocket.instances[0].emitMessage({ k: 'res', id: 1, ok: true, result: '0.0.1-stale' })

    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.instances).toHaveLength(2)
    FakeWebSocket.instances[1].emitOpen()
    FakeWebSocket.instances[1].emitMessage({ k: 'res', id: 1, ok: true, result: LOCAL_VERSION })
    expect(await promise).toEqual({ ok: true })
  })

  it('an error response (old server with no handler for the channel) counts as a failed attempt', async () => {
    const promise = waitForHealth('ws://127.0.0.1:1', 1, 1000)
    await vi.advanceTimersByTimeAsync(0)
    FakeWebSocket.instances[0].emitOpen()
    FakeWebSocket.instances[0].emitMessage({ k: 'res', id: 1, ok: false, error: 'no handler: server:version' })
    expect(await promise).toEqual({ ok: false, reason: `server version mismatch (local ${LOCAL_VERSION}, remote error: no handler: server:version)` })
  })

  it('open followed by a matching version response resolves healthy and does not double count as a failure', async () => {
    const promise = waitForHealth('ws://127.0.0.1:1', 3, 1000)
    await vi.advanceTimersByTimeAsync(0)
    FakeWebSocket.instances[0].emitOpen()
    FakeWebSocket.instances[0].emitMessage({ k: 'res', id: 1, ok: true, result: LOCAL_VERSION })
    expect(await promise).toEqual({ ok: true })

    // Advancing past the fallback window must not spawn another tick or
    // otherwise touch the already-resolved promise.
    await vi.advanceTimersByTimeAsync(2000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('a real error cancels the fallback timer so it does not double-count', async () => {
    const promise = waitForHealth('ws://127.0.0.1:1', 1, 1000)
    await vi.advanceTimersByTimeAsync(0)
    FakeWebSocket.instances[0].emitError(new Error('ECONNREFUSED'))
    expect(await promise).toEqual({ ok: false, reason: 'ECONNREFUSED' })
    expect(FakeWebSocket.instances).toHaveLength(1) // attempts budget of 1, no extra tick
  })
})

describe('spawnTunnel', () => {
  // Real child processes: their exit events are plain IO, so the fake timers
  // installed by beforeEach are irrelevant here - but switch back anyway so a
  // slow spawn can never interleave with a queued fake-timer tick.
  it('passes the summarized ssh stderr through the exit callback as the failure reason', async () => {
    vi.useRealTimers()
    const proc = spawnTunnel('sh', [
      '-c',
      'echo "Warning: Permanently added host" >&2; echo "Permission denied (publickey)." >&2; exit 255',
    ])
    const reason = await new Promise<string | undefined>((resolve) => proc.onExit(resolve))
    expect(reason).toBe('Permission denied (publickey).')
  })

  it('reports no reason when the process exits with a silent stderr', async () => {
    vi.useRealTimers()
    const proc = spawnTunnel('sh', ['-c', 'exit 0'])
    const reason = await new Promise<string | undefined>((resolve) => proc.onExit(resolve))
    expect(reason).toBeUndefined()
  })

  it('drops known-noise stderr lines so chatter alone yields no bogus reason', async () => {
    vi.useRealTimers()
    const proc = spawnTunnel('sh', [
      '-c',
      'echo "WARNING: To increase the performance of the tunnel, consider installing NumPy" >&2; exit 1',
    ])
    const reason = await new Promise<string | undefined>((resolve) => proc.onExit(resolve))
    expect(reason).toBeUndefined()
  })
})

describe('REMOTE_COMMAND', () => {
  it('kills a lingering server tracked by pidfile before launching a fresh one', () => {
    expect(REMOTE_COMMAND).toContain('server.pid')
    expect(REMOTE_COMMAND).toMatch(/kill\s+"\$P"/)
    expect(REMOTE_COMMAND).toContain('node $D/index.cjs')
  })

  it('only kills the pid when it is actually our server (guards against a recycled pid)', () => {
    expect(REMOTE_COMMAND).toContain('/proc/$P/cmdline')
    expect(REMOTE_COMMAND).toContain('grep -qsa index.cjs')
  })
})

describe('allocatePort', () => {
  // Real socket binds - the file-level fake timers don't gate net I/O, but
  // switch to real timers anyway so nothing here depends on the fake clock.
  it('reuses a free preferred port so a reconnect keeps its ws url', async () => {
    vi.useRealTimers()
    const first = await allocatePort()
    expect(first).toBeGreaterThan(0)
    expect(await allocatePort(first)).toBe(first)
  })

  it('falls back to a fresh port when the preferred one is already taken', async () => {
    vi.useRealTimers()
    const srv = createServer()
    const taken = await new Promise<number>((resolve, reject) => {
      srv.once('error', reject)
      srv.listen(0, '127.0.0.1', () => resolve((srv.address() as AddressInfo).port))
    })
    try {
      const port = await allocatePort(taken)
      expect(port).toBeGreaterThan(0)
      expect(port).not.toBe(taken)
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()))
    }
  })
})
