/**
 * A phone's identity rides on the pairing auth and on every session auth
 * after it, so the swap to the minted session must keep it.
 */
import { describe, it, expect, vi } from 'vitest'
import { WsTransport, type TransportSocket } from '../../src/shared/ws-transport'

const DEVICE = { installId: '0b6f3a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', model: 'Pixel 9', platform: 'android' as const }

function fakeSocket(): {
  socket: TransportSocket
  sent: Array<Record<string, unknown>>
  fire: (type: string, event?: unknown) => void
} {
  const events = new Map<string, (event: never) => void>()
  const sent: Array<Record<string, unknown>> = []
  const socket: TransportSocket = {
    send: vi.fn((data: string) => {
      sent.push(JSON.parse(data))
    }),
    close: vi.fn(),
    addEventListener: (type, listener) => {
      events.set(type, listener)
    },
  }
  return { socket, sent, fire: (type, event) => events.get(type)?.(event as never) }
}

describe('WsTransport device identity', () => {
  it('sends the identity on the pairing auth and on the session auth after a reconnect', () => {
    const sockets: Array<ReturnType<typeof fakeSocket>> = []
    const transport = new WsTransport(
      'ws://mac',
      undefined,
      { baseMs: 0 },
      { pairing: 'code', label: 'Mac', device: DEVICE },
      () => {
        const next = fakeSocket()
        sockets.push(next)
        return next.socket
      },
    )
    sockets[0].fire('open')
    expect(sockets[0].sent[0]).toEqual({ k: 'auth', pairing: 'code', label: 'Mac', device: DEVICE })

    sockets[0].fire('message', { data: JSON.stringify({ k: 'authed', ok: true, session: 'minted', scopes: ['chat'] }) })
    transport.forceReconnect()
    const latest = sockets[sockets.length - 1]
    latest.fire('open')
    expect(latest.sent[0]).toEqual({ k: 'auth', session: 'minted', device: DEVICE })
    transport.close()
  })
})
