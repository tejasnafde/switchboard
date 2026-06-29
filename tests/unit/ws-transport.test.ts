/**
 * Loopback test for the remote boundary: a real WsHost (over a ws server) and
 * a real WsTransport (over the global WebSocket) talking the ws-protocol on an
 * ephemeral port. Proves invoke/send/emit round-trip end to end - the contract
 * a future server.js relies on - with no Electron in the loop.
 */
import { describe, it, expect, afterEach } from 'vitest'
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
