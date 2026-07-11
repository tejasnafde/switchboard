/**
 * Loopback test for the remote boundary: a real WsHost (over a ws server) and
 * a real WsTransport (over the global WebSocket) talking the ws-protocol on an
 * ephemeral port. Proves invoke/send/emit round-trip end to end - the contract
 * a future server.js relies on - with no Electron in the loop.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { WebSocketServer, type AddressInfo } from 'ws'
import { WsHost } from '../../src/main/backend/ws-host'
import { WsTransport } from '../../src/shared/ws-transport'

let wss: WebSocketServer | null = null
let client: WsTransport | null = null

async function setup(port = 0): Promise<{ host: WsHost; url: string; port: number }> {
  const server = new WebSocketServer({ port })
  wss = server
  const host = new WsHost(server)
  await new Promise<void>((res, rej) => {
    server.on('listening', () => res())
    server.on('error', rej)
  })
  const actual = (server.address() as AddressInfo).port
  return { host, url: `ws://localhost:${actual}`, port: actual }
}

/** Hard-kill the current server (clients terminated, port released) - the
 *  client sees an unexpected close, as in a real tunnel drop. */
async function killServer(): Promise<void> {
  if (!wss) return
  for (const c of wss.clients) c.terminate()
  await new Promise<void>((res) => wss!.close(() => res()))
  wss = null
}

const tick = () => new Promise((r) => setTimeout(r, 30))

afterEach(async () => {
  client?.close()
  client = null
  await new Promise<void>((res) => (wss ? wss.close(() => res()) : res()))
  wss = null
})

describe('WsTransport ↔ WsHost loopback', () => {
  it('invoke round-trips args and result', async () => {
    const { host, url } = await setup()
    host.handle('echo', (x: number) => ({ got: x }))
    client = new WsTransport(url)
    expect(await client.invoke('echo', 42)).toEqual({ got: 42 })
  })

  it('invoke rejects when the handler throws', async () => {
    const { host, url } = await setup()
    host.handle('boom', () => {
      throw new Error('nope')
    })
    client = new WsTransport(url)
    await expect(client.invoke('boom')).rejects.toThrow('nope')
  })

  it('invoke rejects when no handler is registered', async () => {
    const { url } = await setup()
    client = new WsTransport(url)
    await expect(client.invoke('missing')).rejects.toThrow('no handler')
  })

  it('send (fire-and-forget) reaches a host listener', async () => {
    const { host, url } = await setup()
    const seen: number[] = []
    host.on('tick', (n: number) => seen.push(n))
    client = new WsTransport(url)
    client.send('tick', 7)
    // The send is queued until the socket opens; a round-trip guarantees it
    // flushed (FIFO) and the host processed it before we assert.
    await client.invoke('__ready__').catch(() => {})
    expect(seen).toEqual([7])
  })

  it('emit pushes an event to the client', async () => {
    const { host, url } = await setup()
    const seen: string[] = []
    client = new WsTransport(url)
    client.on('evt:x', (msg: string) => seen.push(msg))
    // wait for the client to actually connect before broadcasting
    await client.invoke('__ready__').catch(() => {})
    host.emit('evt:x', 'hi')
    await tick()
    expect(seen).toEqual(['hi'])
  })
})

describe('WsTransport re-dial (real server)', () => {
  // Small backoff so blips heal within test time; generous budget so a slow
  // CI restart never trips the give-up path in the healing tests.
  const fastReconnect = { baseMs: 30, capMs: 60, budgetMs: 10_000 }

  it('re-dials after a server restart on the same port; push subscriptions survive', async () => {
    const { host, url, port } = await setup()
    host.handle('echo', (x: number) => x)
    client = new WsTransport(url, 30_000, fastReconnect)
    const seen: string[] = []
    client.on('evt:x', (msg: string) => seen.push(msg))
    expect(await client.invoke('echo', 1)).toBe(1)
    host.emit('evt:x', 'before')
    await tick()

    await killServer()
    await tick() // let the client observe the close so the invoke below queues
    const again = await setup(port)
    again.host.handle('echo', (x: number) => x)

    // The invoke queues until the re-dial lands, then flushes - same transport
    // object, so the pre-drop subscription must keep receiving pushes.
    expect(await client.invoke('echo', 2)).toBe(2)
    again.host.emit('evt:x', 'after')
    await tick()
    expect(seen).toEqual(['before', 'after'])
    expect(client.isAlive()).toBe(true)
  })

  it('queues an invoke made while reconnecting and flushes it after the re-dial', async () => {
    const { host, url, port } = await setup()
    host.handle('echo', (x: number) => x)
    client = new WsTransport(url, 30_000, fastReconnect)
    expect(await client.invoke('echo', 1)).toBe(1)

    await killServer()
    await tick() // let the close event land so the invoke below queues instead of hitting a dead socket
    const queued = client.invoke('echo', 2)

    const again = await setup(port)
    again.host.handle('echo', (x: number) => x)
    expect(await queued).toBe(2)
  })

  it('a deliberate close() does not re-dial', async () => {
    const { host, url } = await setup()
    let connections = 0
    wss!.on('connection', () => connections++)
    host.handle('echo', (x: number) => x)
    client = new WsTransport(url, 30_000, { baseMs: 10, capMs: 20, budgetMs: 1_000 })
    expect(await client.invoke('echo', 1)).toBe(1)
    expect(connections).toBe(1)

    client.close()
    expect(client.isAlive()).toBe(false)
    await new Promise((r) => setTimeout(r, 80)) // several backoff periods
    expect(connections).toBe(1)
    await expect(client.invoke('echo', 2)).rejects.toThrow('transport closed')
  })

  it('keeps re-dialing past the budget (never self-terminates) and heals on a late restart', async () => {
    const { host, url, port } = await setup()
    host.handle('echo', (x: number) => x)
    client = new WsTransport(url, 30_000, { baseMs: 20, capMs: 40, budgetMs: 150 })
    expect(await client.invoke('echo', 1)).toBe(1)

    await killServer()
    await tick()
    // Well past the budget: still alive, still re-dialing. Only the connection
    // manager may terminally close a transport (a self-shutdown wedged
    // permanently when the manager stayed 'connected' through the outage).
    await new Promise((r) => setTimeout(r, 300))
    expect(client.isAlive()).toBe(true)

    const queued = client.invoke('echo', 2)
    const again = await setup(port)
    again.host.handle('echo', (x: number) => x)
    expect(await queued).toBe(2)
  })
})

/**
 * Fake-socket unit tests: a minimal stand-in for the browser WebSocket that
 * lets us fire 'open'/'close' and inspect exactly what was sent, without a
 * real server or waiting out real timeouts.
 */
class FakeSocket {
  static instances: FakeSocket[] = []
  private readonly listeners: Record<string, Array<(ev?: unknown) => void>> = {}
  readonly sent: string[] = []
  constructor(public url: string) {
    FakeSocket.instances.push(this)
  }
  addEventListener(ev: string, cb: (ev?: unknown) => void): void {
    ;(this.listeners[ev] ??= []).push(cb)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.fire('close')
  }
  fire(ev: string, arg?: unknown): void {
    for (const cb of this.listeners[ev] ?? []) cb(arg)
  }
}

describe('WsTransport (fake socket)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    FakeSocket.instances.length = 0
  })

  function makeOpenTransport(): { t: WsTransport; sock: FakeSocket } {
    vi.stubGlobal('WebSocket', FakeSocket)
    const t = new WsTransport('ws://fake')
    const sock = FakeSocket.instances.at(-1)!
    sock.fire('open')
    return { t, sock }
  }

  it('strips trailing undefined args before serializing (JSON would otherwise turn them into null)', () => {
    const { t, sock } = makeOpenTransport()
    t.send('files:write-file', 'repo', 'sub', 'content', undefined)
    const frame = JSON.parse(sock.sent[0])
    expect(frame.args).toEqual(['repo', 'sub', 'content'])
  })

  it('only strips trailing undefined, leaving interior undefined as null like structured clone would not', () => {
    const { t, sock } = makeOpenTransport()
    t.send('ch', 'a', undefined, 'b')
    const frame = JSON.parse(sock.sent[0])
    expect(frame.args).toEqual(['a', null, 'b'])
  })

  it('gives provider:* channels a longer timeout than the 30s default', async () => {
    vi.useFakeTimers()
    const { t } = makeOpenTransport()

    const rejected = vi.fn()
    t.invoke('provider:start-session').catch(rejected)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(rejected).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(170_001)
    expect(rejected).toHaveBeenCalled()
  })

  it('keeps the 30s default timeout for non-provider channels', async () => {
    vi.useFakeTimers()
    const { t } = makeOpenTransport()

    const rejected = vi.fn()
    t.invoke('files:read-file').catch(rejected)
    await vi.advanceTimersByTimeAsync(30_001)
    expect(rejected).toHaveBeenCalled()
  })

  it('rejects in-flight invokes on an unexpected close but queues new ones for the re-dial', async () => {
    vi.useFakeTimers()
    const { t, sock } = makeOpenTransport()
    const pending = t.invoke('ch')
    sock.fire('close')
    // The in-flight response died with the socket - genuinely lost.
    await expect(pending).rejects.toThrow('WebSocket closed')
    // A new invoke queues for the re-dial instead of rejecting.
    const rejected = vi.fn()
    void t.invoke('ch2').catch(rejected)
    await vi.advanceTimersByTimeAsync(0)
    expect(rejected).not.toHaveBeenCalled()
    t.close()
  })

  it('re-dials on the backoff schedule and flushes queued frames over the new socket', async () => {
    vi.useFakeTimers()
    const { t, sock } = makeOpenTransport()
    sock.fire('close')
    t.send('queued-ch', 1)
    void t.invoke('queued-invoke').catch(() => {})
    expect(FakeSocket.instances).toHaveLength(1) // no immediate dial

    await vi.advanceTimersByTimeAsync(500) // first backoff step
    expect(FakeSocket.instances).toHaveLength(2)
    const sock2 = FakeSocket.instances.at(-1)!
    sock2.fire('open')
    expect(sock2.sent.map((s) => JSON.parse(s).ch)).toEqual(['queued-ch', 'queued-invoke'])
    t.close()
  })

  it('rejects invokes beyond the disconnected-queue bound instead of piling up unbounded', async () => {
    vi.useFakeTimers()
    const { t, sock } = makeOpenTransport()
    sock.fire('close')
    for (let i = 0; i < 100; i++) void t.invoke(`ch${i}`).catch(() => {})
    await expect(t.invoke('overflow')).rejects.toThrow('transport queue full')
    t.close()
  })

  it('a deliberate close() rejects new invokes and never re-dials', async () => {
    vi.useFakeTimers()
    const { t } = makeOpenTransport()
    t.close()
    expect(t.isAlive()).toBe(false)
    await expect(t.invoke('ch')).rejects.toThrow('transport closed')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('drops send() after a deliberate close instead of queuing it into the outbox', () => {
    const { t, sock } = makeOpenTransport()
    t.close()
    const sentBefore = sock.sent.length
    t.send('ch')
    expect(sock.sent.length).toBe(sentBefore)
  })
})
