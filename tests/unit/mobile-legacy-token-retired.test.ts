/**
 * The shared pairing token (`mobilePairing.token`) is retired. The real mobile
 * endpoint deletes the stored value on apply and closes a phone that still
 * dials with it with 4001, which phones show as "removed, pair again".
 */
import { createMigratedDb } from './helpers/test-db'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebSocket } from 'ws'
import { connect, createServer, type AddressInfo } from 'node:net'
import { until } from './helpers/wait'

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))
vi.mock('../../src/main/backend/tls', () => ({
  loadOrCreateTlsIdentity: () => {
    throw new Error('no tls in this test')
  },
  DualWebSocketServer: class {},
}))

const { MobileEndpoint } = await import('../../src/main/backend/mobile-server')
const { getSetting, setSetting } = await import('../../src/main/db/database')

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

/** How the dial ended: a reply to a probe request, or the close code. */
function dial(url: string): Promise<'open' | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    let settled = false
    const settle = (v: 'open' | number): void => {
      if (settled) return
      settled = true
      ws.terminate()
      resolve(v)
    }
    ws.on('open', () => ws.send(JSON.stringify({ k: 'req', id: 1, ch: 'probe', args: [] })))
    ws.on('message', (data) => {
      if ((JSON.parse(data.toString()) as { k?: string }).k === 'res') settle('open')
    })
    ws.on('close', (code) => settle(code))
    ws.on('error', () => {})
  })
}

let endpoint: InstanceType<typeof MobileEndpoint>
let port: number

beforeEach(async () => {
  createMigratedDb()
  port = await freePort()
  setSetting('mobilePairing.enabled', 'true')
  setSetting('mobilePairing.port', String(port))
  setSetting('mobilePairing.token', 'old-shared-token')
  endpoint = new MobileEndpoint()
  endpoint.handle('probe', () => 'ok')
  endpoint.apply()
  await until(() => accepts(port))
})

/** Resolves once something accepts a TCP connection on `port`. */
function accepts(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve()
    })
    socket.once('error', reject)
  })
}

afterEach(() => endpoint.close())

describe('retired shared pairing token', () => {
  it('deletes the stored token on apply', () => {
    expect(getSetting('mobilePairing.token')).toBeNull()
  })

  it('closes a phone dialing with the old token with 4001', async () => {
    expect(await dial(`ws://127.0.0.1:${port}/?token=old-shared-token`)).toBe(4001)
  })

  it('does not start the endpoint from a token alone', () => {
    endpoint.close()
    setSetting('mobilePairing.enabled', 'false')
    setSetting('mobilePairing.token', 'old-shared-token')
    expect(new MobileEndpoint().apply()).toMatchObject({ listening: false })
  })
})
