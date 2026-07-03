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

async function setup(): Promise<{ host: WsHost; url: string }> {
  const server = new WebSocketServer({ port: 0 })
  wss = server
  const host = new WsHost(server)
  await new Promise<void>((res) => server.on('listening', () => res()))
  const { port } = server.address() as AddressInfo
  return { host, url: `ws://localhost:${port}` }
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

  it('rejects in-flight invokes and rejects new invokes immediately on close (no 30s hang)', async () => {
    const { t, sock } = makeOpenTransport()
    const pending = t.invoke('ch')
    sock.fire('close')
    await expect(pending).rejects.toThrow('WebSocket closed')
    await expect(t.invoke('ch2')).rejects.toThrow('transport closed')
  })

  it('drops send() after close instead of queuing it into the outbox', () => {
    const { t, sock } = makeOpenTransport()
    sock.fire('close')
    const sentBefore = sock.sent.length
    t.send('ch')
    expect(sock.sent.length).toBe(sentBefore)
  })
})
