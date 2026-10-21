/**
 * End-to-end resume over a real WsHost + WsTransport: a client that drops and
 * reconnects must see the events emitted while it was away, exactly once, in
 * order - and must be told to re-seed when that is not possible.
 *
 * This is the hole the mobile client used to have: every runtime event emitted
 * while the phone was backgrounded was lost with no way to notice.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { until } from './helpers/wait'
import { WebSocketServer, type AddressInfo } from 'ws'
import { WsHost } from '../../src/main/backend/ws-host'
import { WsTransport } from '../../src/shared/ws-transport'
import { decodeFrame, isReplayableEventChannel } from '../../src/shared/ws-protocol'

let wss: WebSocketServer | null = null
let client: WsTransport | null = null

async function setup(): Promise<{ host: WsHost; url: string }> {
  const server = new WebSocketServer({ port: 0 })
  wss = server
  const host = new WsHost(server)
  await new Promise<void>((res, rej) => {
    server.on('listening', () => res())
    server.on('error', rej)
  })
  return { host, url: `ws://localhost:${(server.address() as AddressInfo).port}` }
}

/** Drop the client's socket from the server side without closing the server,
 *  so the same host (and its replay buffer) is still there on reconnect. */
function dropClients(): void {
  for (const c of wss!.clients) c.terminate()
}

/**
 * Resolves once the client has reconnected and been answered a request. The
 * host handles frames in order, so by then it has sent the replay and `ready`
 * for the client's hello. Call before the drop, so the reconnect is not missed.
 */
async function reconnected(c: WsTransport): Promise<void> {
  await new Promise<void>((resolve) => {
    c.onStateChange = (state) => {
      if (state === 'connected') resolve()
    }
  })
  await c.invoke('__ready__').catch(() => {})
}

afterEach(async () => {
  client?.close()
  client = null
  await new Promise<void>((res) => (wss ? wss.close(() => res()) : res()))
  wss = null
})

describe('event resume', () => {
  it('replays events emitted while the client was disconnected', async () => {
    const { host, url } = await setup()
    const seen: number[] = []
    client = new WsTransport(url)
    client.on('provider:event', (n) => seen.push(n as number))
    await client.invoke('__ready__').catch(() => {})

    host.emit('provider:event', 1)
    await until(() => expect(seen).toEqual([1]))

    const back = reconnected(client)
    dropClients()
    // Emitted with nobody listening - previously lost for good.
    host.emit('provider:event', 2)
    host.emit('provider:event', 3)

    await back
    expect(seen).toEqual([1, 2, 3])
  })

  it('baselines on ready, so an event missed after an idle connection is replayed alone', async () => {
    const { host, url } = await setup()
    host.emit('provider:event', 1)
    host.emit('provider:event', 2)
    const seen: number[] = []
    client = new WsTransport(url)
    client.on('provider:event', (n) => seen.push(n as number))
    await client.invoke('__ready__').catch(() => {})

    const back = reconnected(client)
    dropClients()
    host.emit('provider:event', 3)
    await back
    expect(seen).toEqual([3])
  })

  it('does not redeliver events the client already applied', async () => {
    const { host, url } = await setup()
    const seen: number[] = []
    client = new WsTransport(url)
    client.on('provider:event', (n) => seen.push(n as number))
    await client.invoke('__ready__').catch(() => {})

    host.emit('provider:event', 1)
    host.emit('provider:event', 2)
    await until(() => expect(seen).toEqual([1, 2]))
    const back = reconnected(client)
    dropClients()
    await back

    expect(seen).toEqual([1, 2])
  })

  it('signals a gap when the buffer no longer holds what the client missed', async () => {
    const { host, url } = await setup()
    let gaps = 0
    client = new WsTransport(url)
    client.onResumeGap = () => gaps++
    await client.invoke('__ready__').catch(() => {})

    const seen: number[] = []
    client.on('provider:event', (n) => seen.push(n as number))
    host.emit('provider:event', 1)
    await until(() => expect(seen).toEqual([1]))
    const back = reconnected(client)
    dropClients()
    // Overflow the buffer so the client's cursor is no longer covered.
    for (let i = 0; i < 2_100; i++) host.emit('provider:event', i)

    await back
    expect(gaps).toBe(1)
  })

  it('a restarted backend reports a new epoch, and the client re-seeds instead of going silent', async () => {
    const { host, url } = await setup()
    let gaps = 0
    client = new WsTransport(url)
    client.onResumeGap = () => gaps++
    const seen: number[] = []
    client.on('provider:event', (n) => seen.push(n as number))
    await client.invoke('__ready__').catch(() => {})

    host.emit('provider:event', 1)
    host.emit('provider:event', 2)
    await until(() => expect(seen).toEqual([1, 2]))

    // Replace the host on the same server: a fresh epoch and seq starting at 0.
    // Without epoch handling the client's cursor of 2 would swallow the next
    // two events forever.
    const restarted = new WsHost(wss!)
    const back = reconnected(client)
    for (const c of wss!.clients) c.terminate()
    await back
    restarted.emit('provider:event', 7)
    await until(() => expect(seen).toContain(7))

    expect(gaps).toBe(1)
  })

  // The server broadcasts to a newly accepted socket before it gets round to
  // that socket's `hello`. If the client applied that live event first it would
  // advance its cursor past the replay, and every replayed frame would then be
  // discarded as a duplicate - losing exactly what this mechanism recovers,
  // while the server logged a successful resume.
  it('does not lose the replay when a live event arrives during the handshake', async () => {
    const { host, url } = await setup()
    const seen: number[] = []
    client = new WsTransport(url)
    client.on('provider:event', (n) => seen.push(n as number))
    await client.invoke('__ready__').catch(() => {})

    host.emit('provider:event', 1)
    await until(() => expect(seen).toEqual([1]))
    const back = reconnected(client)
    dropClients()
    host.emit('provider:event', 2)
    host.emit('provider:event', 3)

    // Fire a live event on every new connection, so one lands ahead of the
    // replay the reconnect is about to request.
    wss!.on('connection', () => host.emit('provider:event', 99))

    await back
    expect(seen).toEqual([1, 2, 3, 99])
  })

  it('terminal output is excluded from the sequence space so it cannot evict provider events', async () => {
    // terminal:data is the CLIENT-to-server keystroke channel and never travels
    // as an evt, so naming it here excluded nothing while pty output - which is
    // terminal:output - poured into the buffer and evicted provider events.
    expect(isReplayableEventChannel('terminal:output')).toBe(false)
    expect(isReplayableEventChannel('terminal:exit')).toBe(false)
    expect(isReplayableEventChannel('provider:event')).toBe(true)

    const { host, url } = await setup()
    const frames: Array<{ ch: string; seq?: number }> = []

    // A plain socket, so the assertion is against the wire itself rather than
    // whatever WsTransport chose to do with the frames.
    const raw = new WebSocket(url)
    await new Promise((r) => raw.addEventListener('open', r))
    raw.addEventListener('message', (ev: MessageEvent) => {
      const f = decodeFrame(String(ev.data))
      if (f?.k === 'evt') frames.push({ ch: f.ch, seq: f.seq })
    })
    host.emit('terminal:output', 'noise')
    host.emit('provider:event', 'signal')
    // Sent in order, so the noise is in by the time the signal is.
    await until(() => expect(frames.map((f) => f.ch)).toContain('provider:event'))
    raw.close()

    expect(frames.find((f) => f.ch === 'terminal:output')?.seq).toBeUndefined()
    expect(frames.find((f) => f.ch === 'provider:event')?.seq).toBe(1)
  })
})

/**
 * The mobile endpoint binds 0.0.0.0, so anything an unauthenticated socket can
 * read is readable by the whole LAN. Requests were gated from the start; events
 * and replay were not, which made the token a write-only control.
 */
describe('unauthenticated clients', () => {
  it('receive no events and cannot be replayed the buffer', async () => {
    const server = new WebSocketServer({ port: 0 })
    wss = server
    const host = new WsHost(server, 's3cret')
    await new Promise<void>((res) => server.on('listening', () => res()))
    const url = `ws://localhost:${(server.address() as AddressInfo).port}/?auth=frame`

    const frames: string[] = []
    const raw = new WebSocket(url)
    await new Promise((r) => raw.addEventListener('open', r))
    raw.addEventListener('message', (ev: MessageEvent) => frames.push(String(ev.data)))

    // Ask to be replayed everything, then wait for live traffic. The host
    // answers frames in order, so anything it sent this socket lands before
    // the refusal of the request that follows.
    raw.send(JSON.stringify({ k: 'hello', since: 0 }))
    host.emit('provider:event', 'secret')
    raw.send(JSON.stringify({ k: 'req', id: 1, ch: 'probe', args: [] }))
    await until(() => expect(frames.map((f) => decodeFrame(f)?.k)).toContain('res'))
    raw.close()

    const kinds = frames.map((f) => decodeFrame(f)?.k)
    expect(kinds).not.toContain('evt')
    expect(kinds).not.toContain('ready')
  })
})
