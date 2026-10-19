/**
 * Device identity (device_identity_v1): the wire field, the stored session
 * fields, a re-paired install superseding its old session, and the throttled
 * lastSeenAt refresh.
 */
import { createMigratedDb } from './helpers/test-db'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

const { parseDeviceIdentity, DEVICE_IDENTITY_CAPABILITY } = await import('../../src/shared/device-identity')
const { BACKEND_CAPABILITIES, decodeFrame } = await import('../../src/shared/ws-protocol')
const sessions = await import('../../src/main/backend/device-sessions')
const { setSetting, getSetting } = await import('../../src/main/db/database')
const { WsHost } = await import('../../src/main/backend/ws-host')

const PIXEL = {
  installId: '0b6f3a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
  name: "Tejas's Pixel",
  manufacturer: 'Google',
  model: 'Pixel 9',
  platform: 'android' as const,
  osVersion: '16',
  appVersion: '0.5.19',
}

describe('parseDeviceIdentity', () => {
  it('keeps every known field', () => {
    expect(parseDeviceIdentity(PIXEL)).toEqual(PIXEL)
  })

  it('needs a usable installId', () => {
    expect(parseDeviceIdentity({ ...PIXEL, installId: '' })).toBeNull()
    expect(parseDeviceIdentity({ ...PIXEL, installId: 'has spaces in it' })).toBeNull()
    expect(parseDeviceIdentity({ ...PIXEL, installId: 42 })).toBeNull()
    expect(parseDeviceIdentity(null)).toBeNull()
    expect(parseDeviceIdentity([PIXEL])).toBeNull()
  })

  it('drops malformed display fields and bounds long ones', () => {
    const parsed = parseDeviceIdentity({ ...PIXEL, platform: 'windows', model: 7, name: 'x'.repeat(500), extra: 'no' })
    expect(parsed).not.toHaveProperty('platform')
    expect(parsed).not.toHaveProperty('model')
    expect(parsed).not.toHaveProperty('extra')
    expect(parsed?.name).toHaveLength(128)
  })
})

describe('auth frame', () => {
  it('advertises the capability', () => {
    expect(BACKEND_CAPABILITIES).toContain(DEVICE_IDENTITY_CAPABILITY)
  })

  it('carries the identity on a pair and a session auth', () => {
    expect(decodeFrame(JSON.stringify({ k: 'auth', pairing: 'p', label: 'Phone', device: PIXEL }))).toEqual({
      k: 'auth',
      pairing: 'p',
      label: 'Phone',
      session: undefined,
      device: PIXEL,
    })
    expect(decodeFrame(JSON.stringify({ k: 'auth', session: 's', device: PIXEL }))).toMatchObject({ device: PIXEL })
  })

  it('keeps the credential when the identity is malformed, and an old phone sends none', () => {
    const bad = decodeFrame(JSON.stringify({ k: 'auth', session: 's', device: { installId: '' } }))
    expect(bad).toEqual({ k: 'auth', session: 's', pairing: undefined, label: undefined })
    expect(decodeFrame(JSON.stringify({ k: 'auth', pairing: 'p', label: 'Phone' }))).not.toHaveProperty('device')
  })
})

function pair(label: string, device?: typeof PIXEL, address?: string): string {
  const code = sessions.createPairingCode()
  const result = sessions.redeemPairingCode(code.code, label, ['chat'], { device, address })
  expect(result.ok).toBe(true)
  return result.session!
}

describe('device session store', () => {
  beforeEach(() => {
    createMigratedDb()
  })

  afterEach(() => {
    sessions.setRevocationListener(null)
  })

  it('still returns the new token when revoking the superseded session fails', () => {
    pair('Old phone', PIXEL)
    sessions.setRevocationListener(() => {
      throw new Error('push settings could not be saved')
    })
    const code = sessions.createPairingCode()
    const result = sessions.redeemPairingCode(code.code, 'New phone', ['chat'], { device: PIXEL })
    expect(result.ok).toBe(true)
    expect(result.session).toBeTruthy()
    const views = sessions.listSessionViews()
    expect(views.map((v) => v.label)).toEqual(['New phone'])
  })

  it('reads sessions stored before device identity existed', () => {
    setSetting(
      'deviceSessions',
      JSON.stringify([
        { id: 'old', tokenHash: 'ab', label: 'Switchboard Android', scopes: ['chat'], createdAt: 1, lastSeenAt: 2 },
      ]),
    )
    expect(sessions.listSessionViews()).toEqual([
      {
        id: 'old',
        label: 'Switchboard Android',
        scopes: ['chat'],
        createdAt: 1,
        lastSeenAt: 2,
        revoked: false,
        online: false,
      },
    ])
  })

  it('drops a stored identity that does not parse, and keeps the session', () => {
    setSetting(
      'deviceSessions',
      JSON.stringify([
        {
          id: 'x',
          tokenHash: 'ab',
          label: 'L',
          scopes: ['chat'],
          createdAt: 1,
          lastSeenAt: 2,
          identity: { installId: 1 },
        },
      ]),
    )
    const [view] = sessions.listSessionViews()
    expect(view.id).toBe('x')
    expect(view).not.toHaveProperty('installId')
  })

  it('stores the identity and the address, and lists them with the online flag', () => {
    pair('Phone', PIXEL, '::ffff:192.168.1.20')
    const [view] = sessions.listSessionViews()
    expect(view).toMatchObject({ ...PIXEL, label: 'Phone', lastAddress: '192.168.1.20', online: false })
    expect(sessions.listSessionViews(new Set([view.id]))[0].online).toBe(true)
    // The token hash never reaches a view, identity or not.
    expect(view).not.toHaveProperty('tokenHash')
  })

  it('replaces the earlier session when the same install pairs again', () => {
    const revoked: string[] = []
    sessions.setRevocationListener((id) => revoked.push(id))
    const firstToken = pair('Phone', PIXEL)
    const [first] = sessions.listSessionViews()
    pair('Phone', { ...PIXEL, appVersion: '0.5.20' })

    const views = sessions.listSessionViews()
    expect(views).toHaveLength(1)
    expect(views[0].id).not.toBe(first.id)
    expect(views[0].appVersion).toBe('0.5.20')
    expect(revoked).toEqual([first.id])
    expect(sessions.authenticateSession(firstToken)).toBeNull()
  })

  it('keeps both rows for two installs, and for phones that send no identity', () => {
    pair('Phone', PIXEL)
    pair('Phone', { ...PIXEL, installId: 'f00dfeed-0000-4000-8000-000000000001' })
    pair('Switchboard Android')
    pair('Switchboard Android')
    expect(sessions.listSessionViews()).toHaveLength(4)
  })

  it('records a changed identity and address on a session auth', () => {
    const token = pair('Phone', PIXEL, '10.0.0.5')
    sessions.authenticateSession(token, { device: { ...PIXEL, osVersion: '17' }, address: '100.64.0.9' }, 5_000)
    const [view] = sessions.listSessionViews()
    expect(view).toMatchObject({ osVersion: '17', lastAddress: '100.64.0.9', lastSeenAt: 5_000 })
    // An auth without an identity (an old app) keeps what was recorded.
    sessions.authenticateSession(token, {}, 6_000)
    expect(sessions.listSessionViews()[0]).toMatchObject({ osVersion: '17', lastAddress: '100.64.0.9' })
  })

  it('refreshes lastSeenAt for a live session only', () => {
    pair('Phone', PIXEL)
    const [view] = sessions.listSessionViews()
    expect(sessions.touchSession(view.id, 9_000)).toBe(true)
    expect(sessions.listSessionViews()[0].lastSeenAt).toBe(9_000)
    sessions.revokeSession(view.id)
    expect(sessions.touchSession(view.id, 10_000)).toBe(false)
    expect(sessions.touchSession('missing', 10_000)).toBe(false)
    expect(getSetting('deviceSessions')).toContain('"lastSeenAt":9000')
  })
})

describe('WsHost lastSeenAt refresh', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn()
    vi.restoreAllMocks()
  })

  it('refreshes on traffic at most once per interval, and reports the session online', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const touched: number[] = []
    const contexts: unknown[] = []
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    const host = new WsHost(
      wss,
      undefined,
      {
        redeem: () => ({ ok: false }),
        authenticate: (_session, context) => {
          contexts.push(context)
          return { id: 'dev-1', scopes: ['chat'] }
        },
        touch: () => touched.push(now),
      },
      true,
    )
    cleanups.push(() => {
      host.dispose()
      wss.close()
    })
    await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
    const ws = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}/?auth=frame`)
    cleanups.push(() => ws.terminate())
    const frames: Array<Record<string, unknown>> = []
    ws.on('message', (data) => frames.push(JSON.parse(data.toString())))
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))

    const exchange = async (frame: object): Promise<void> => {
      const before = frames.length
      ws.send(JSON.stringify(frame))
      ws.send(JSON.stringify({ k: 'ping', t: 0 }))
      await vi.waitFor(() => expect(frames.length).toBeGreaterThan(before))
    }

    await exchange({ k: 'auth', session: 'tok', device: PIXEL })
    expect(contexts[0]).toMatchObject({ device: PIXEL, address: '127.0.0.1' })
    expect(host.onlineSessionIds()).toEqual(new Set(['dev-1']))

    now += 30_000
    await exchange({ k: 'pong', t: 0 })
    expect(touched).toEqual([])
    now += 31_000
    await exchange({ k: 'pong', t: 0 })
    expect(touched).toEqual([now])
    now += 10_000
    await exchange({ k: 'pong', t: 0 })
    expect(touched).toHaveLength(1)

    host.disconnectSession('dev-1')
    expect(host.onlineSessionIds()).toEqual(new Set())
  })
})
