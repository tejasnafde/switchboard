/**
 * The mobile pairing endpoint must not restart when nothing changed.
 *
 * Regression: the Settings tab re-applies on every edit to host, port or token.
 * Because apply() closed the listener and terminate()d every client, editing
 * the host field kicked a connected phone off once per keystroke - it
 * reconnected, was killed by the next apply, and sat on "connecting" forever.
 * The host is not even part of the listener; it only labels the QR.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const settings = new Map<string, string>()
const terminated: string[] = []
let created = 0

vi.mock('../../src/main/db/database', () => ({
  getSetting: (k: string) => settings.get(k) ?? null,
  setSetting: (k: string, v: string) => void settings.set(k, v),
}))

vi.mock('ws', () => {
  class FakeWebSocketServer {
    clients = new Set<{ terminate: () => void }>()
    private handlers = new Map<string, (arg?: unknown) => void>()
    constructor(readonly opts: { port: number; host: string }) {
      created++
      // One connected phone, so a restart is observable.
      this.clients.add({ terminate: () => terminated.push(`port-${opts.port}`) })
    }
    on(event: string, fn: (arg?: unknown) => void): void {
      this.handlers.set(event, fn)
      if (event === 'listening') fn()
    }
    close(cb?: () => void): void {
      cb?.()
    }
  }
  return { WebSocketServer: FakeWebSocketServer, default: {} }
})

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

const { MobileEndpoint } = await import('../../src/main/backend/mobile-server')

beforeEach(() => {
  settings.clear()
  settings.set('mobilePairing.token', 'tok-1')
  settings.set('mobilePairing.port', '8765')
  terminated.length = 0
  created = 0
})

describe('MobileEndpoint.apply', () => {
  it('starts a listener on the configured port', () => {
    const ep = new MobileEndpoint()
    const status = ep.apply()
    expect(status).toMatchObject({ listening: true, port: 8765 })
    expect(created).toBe(1)
  })

  it('does not restart, or drop clients, when nothing changed', () => {
    const ep = new MobileEndpoint()
    ep.apply()
    ep.apply()
    ep.apply()

    expect(created).toBe(1)
    expect(terminated).toEqual([])
  })

  it('ignores a host change, which only labels the QR', () => {
    const ep = new MobileEndpoint()
    ep.apply()
    settings.set('mobilePairing.host', '100.99.40.43')
    ep.apply()

    expect(created).toBe(1)
    expect(terminated).toEqual([])
  })

  it('restarts when the port changes', () => {
    const ep = new MobileEndpoint()
    ep.apply()
    settings.set('mobilePairing.port', '9000')
    const status = ep.apply()

    expect(created).toBe(2)
    expect(terminated).toEqual(['port-8765'])
    expect(status.port).toBe(9000)
  })

  it('restarts when the token is rotated, since old clients must re-auth', () => {
    const ep = new MobileEndpoint()
    ep.apply()
    settings.set('mobilePairing.token', 'tok-2')
    ep.apply()

    expect(created).toBe(2)
    expect(terminated).toEqual(['port-8765'])
  })

  it('stays off with no token, and does not start on repeated applies', () => {
    settings.delete('mobilePairing.token')
    const ep = new MobileEndpoint()
    expect(ep.apply()).toMatchObject({ listening: false })
    ep.apply()
    expect(created).toBe(0)
  })
})
