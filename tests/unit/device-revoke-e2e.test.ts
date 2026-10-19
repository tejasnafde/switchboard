/**
 * Revoking a paired phone, end to end through the real mobile endpoint and the
 * real device-session store: the open socket closes with 4001 at once, the
 * token is refused on the next dial, its push tokens are gone, and it leaves
 * the device list.
 */
import { createMigratedDb } from './helpers/test-db'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebSocket } from 'ws'
import { createServer, type AddressInfo } from 'node:net'

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))
// Plain ws:// keeps the test off the certificate path, which has its own tests.
vi.mock('../../src/main/backend/tls', () => ({
  loadOrCreateTlsIdentity: () => {
    throw new Error('no tls in this test')
  },
  DualWebSocketServer: class {},
}))

const { MobileEndpoint } = await import('../../src/main/backend/mobile-server')
const { createPairingCode, listSessionViews, revokeSession } = await import('../../src/main/backend/device-sessions')
const { setSetting } = await import('../../src/main/db/database')
const { registerDevice, listDevices } = await import('../../src/main/push/registry')
const { currentBackendRequestContext } = await import('../../src/main/backend/request-context')

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

interface Client {
  ws: WebSocket
  next: () => Promise<Record<string, unknown>>
  closed: Promise<number>
}

async function dial(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?auth=frame`)
  const queue: Record<string, unknown>[] = []
  const waiters: Array<(v: Record<string, unknown>) => void> = []
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>
    if (frame.k === 'ping') return
    const waiter = waiters.shift()
    if (waiter) waiter(frame)
    else queue.push(frame)
  })
  ws.on('error', () => {})
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)))
  await new Promise<void>((resolve) => ws.on('open', () => resolve()))
  return {
    ws,
    closed,
    next: () =>
      new Promise((resolve) => {
        const frame = queue.shift()
        if (frame) resolve(frame)
        else waiters.push(resolve)
      }),
  }
}

let endpoint: InstanceType<typeof MobileEndpoint>
const open: WebSocket[] = []

beforeEach(async () => {
  createMigratedDb()
  setSetting('mobilePairing.enabled', 'true')
  setSetting('mobilePairing.port', String(await freePort()))
  endpoint = new MobileEndpoint()
  // What a phone calls after pairing; the owner comes from the request context.
  endpoint.handle('push:register', (token: string) =>
    registerDevice(token, 'ios', 'conn-1', currentBackendRequestContext()?.deviceSessionId),
  )
  endpoint.handle('probe', () => 'ok')
})

afterEach(() => {
  for (const ws of open.splice(0)) ws.terminate()
  endpoint.close()
})

async function pairPhone(port: number, device?: object): Promise<{ client: Client; session: string }> {
  const client = await dial(port)
  open.push(client.ws)
  client.ws.send(JSON.stringify({ k: 'auth', pairing: createPairingCode().code, label: 'Pixel 9', device }))
  const authed = await client.next()
  expect(authed).toMatchObject({ k: 'authed', ok: true })
  return { client, session: authed.session as string }
}

describe('revoking a paired device', () => {
  it('closes its open socket, refuses its token on reconnect, and drops its push tokens', async () => {
    const { port } = endpoint.apply() as { port: number }
    const { client, session } = await pairPhone(port)
    client.ws.send(JSON.stringify({ k: 'req', id: 1, ch: 'push:register', args: ['ExponentPushToken[a]'] }))
    expect(await client.next()).toMatchObject({ k: 'res', id: 1, ok: true })
    expect(listDevices().map((d) => d.token)).toEqual(['ExponentPushToken[a]'])

    const [device] = listSessionViews()
    expect(revokeSession(device.id)).toBe(true)

    expect(await client.closed).toBe(4001)
    expect(listDevices()).toEqual([])
    // Gone from the list, or Revoke reads as having done nothing.
    expect(listSessionViews()).toEqual([])

    const again = await dial(port)
    open.push(again.ws)
    again.ws.send(JSON.stringify({ k: 'auth', session }))
    expect(await again.next()).toMatchObject({ k: 'authed', ok: false })
    expect(await again.closed).toBe(4001)
  })

  it('keeps other devices connected', async () => {
    const { port } = endpoint.apply() as { port: number }
    const first = await pairPhone(port)
    const second = await pairPhone(port)
    const [a, b] = listSessionViews()
    revokeSession(a.id)
    expect(await first.client.closed).toBe(4001)
    expect(listSessionViews().map((d) => d.id)).toEqual([b.id])
    second.client.ws.send(JSON.stringify({ k: 'req', id: 7, ch: 'probe', args: [] }))
    expect(await second.client.next()).toMatchObject({ k: 'res', id: 7, ok: true, result: 'ok' })
  })

  it('still cuts off a device after the endpoint was re-applied with a new port', async () => {
    endpoint.apply()
    setSetting('mobilePairing.port', String(await freePort()))
    const { port } = endpoint.apply() as { port: number }
    const { client } = await pairPhone(port)
    revokeSession(listSessionViews()[0].id)
    expect(await client.closed).toBe(4001)
  })

  it('replaces the session a reinstalled phone left behind, closing its socket and dropping its push tokens', async () => {
    const { port } = endpoint.apply() as { port: number }
    const device = { installId: '0b6f3a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', model: 'Pixel 9', platform: 'android' }
    const before = await pairPhone(port, device)
    before.client.ws.send(JSON.stringify({ k: 'req', id: 1, ch: 'push:register', args: ['ExponentPushToken[a]'] }))
    expect(await before.client.next()).toMatchObject({ k: 'res', id: 1, ok: true })
    expect(listSessionViews()).toMatchObject([{ installId: device.installId, lastAddress: '127.0.0.1', online: false }])
    expect(endpoint.onlineSessionIds().size).toBe(1)

    const after = await pairPhone(port, device)
    expect(await before.client.closed).toBe(4001)
    expect(listDevices()).toEqual([])
    const views = listSessionViews(endpoint.onlineSessionIds())
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({ model: 'Pixel 9', online: true })
    after.client.ws.send(JSON.stringify({ k: 'req', id: 2, ch: 'probe', args: [] }))
    expect(await after.client.next()).toMatchObject({ k: 'res', id: 2, ok: true, result: 'ok' })
  })
})
