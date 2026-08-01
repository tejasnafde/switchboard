/**
 * End-to-end resume over a real WsHost + WsTransport: a client that drops and
 * reconnects must see the events emitted while it was away, exactly once, in
 * order - and must be told to re-seed when that is not possible.
 *
 * This is the hole the mobile client used to have: every runtime event emitted
 * while the phone was backgrounded was lost with no way to notice.
 */
import { describe, it, expect, afterEach } from 'vitest'
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

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms))

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
    await settle()
    expect(seen).toEqual([1])

    dropClients()
    // Emitted with nobody listening - previously lost for good.
    host.emit('provider:event', 2)
    host.emit('provider:event', 3)

    await settle(900)
    expect(seen).toEqual([1, 2, 3])
  })

  it('does not redeliver events the client already applied', async () => {
    const { host, url } = await setup()
    const seen: number[] = []
    client = new WsTransport(url)
    client.on('provider:event', (n) => seen.push(n as number))
    await client.invoke('__ready__').catch(() => {})

    host.emit('provider:event', 1)
    host.emit('provider:event', 2)
    await settle()
    dropClients()
    await settle(900)

    expect(seen).toEqual([1, 2])
  })

  it('signals a gap when the buffer no longer holds what the client missed', async () => {
    const { host, url } = await setup()
    let gaps = 0
    client = new WsTransport(url)
    client.onResumeGap = () => gaps++
    await client.invoke('__ready__').catch(() => {})

    host.emit('provider:event', 1)
    await settle()
    dropClients()
    // Overflow the buffer so the client's cursor is no longer covered.
    for (let i = 0; i < 2_100; i++) host.emit('provider:event', i)

    await settle(900)
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
    await settle()
    expect(seen).toEqual([1, 2])

    // Replace the host on the same server: a fresh epoch and seq starting at 0.
    // Without epoch handling the client's cursor of 2 would swallow the next
    // two events forever.
    const restarted = new WsHost(wss!)
    for (const c of wss!.clients) c.terminate()
    await settle(900)
    restarted.emit('provider:event', 7)
    await settle()

    expect(gaps).toBe(1)
    expect(seen).toContain(7)
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
    await settle()
    dropClients()
    host.emit('provider:event', 2)
    host.emit('provider:event', 3)

    // Fire a live event on every new connection, so one lands ahead of the
    // replay the reconnect is about to request.
    wss!.on('connection', () => host.emit('provider:event', 99))

    await settle(1_200)
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
    await settle()
    raw.close()

    expect(frames.find((f) => f.ch === 'terminal:output')?.seq).toBeUndefined()
    expect(frames.find((f) => f.ch === 'provider:event')?.seq).toBe(1)
  })
})
