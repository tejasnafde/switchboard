/**
 * The settings rows that hold device credentials and pairing grants must be out
 * of reach of a chat-scoped device, through the same WsHost gate a phone hits.
 * `settings:set` and `settings:get` are open channels, so the gate is per key.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import { AddressInfo } from 'node:net'
import { WsHost } from '../../src/main/backend/ws-host'
import {
  ADMIN_ONLY_SETTING_FAMILIES,
  FULL_SCOPES,
  PHONE_SCOPES,
  isSettingReadAllowed,
  isSettingWriteAllowed,
  isSettingsFrameAllowed,
} from '../../src/shared/device-auth'
import { projectOverrideKey } from '../../src/shared/project-settings'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

interface Client {
  call: (ch: string, args: unknown[]) => Promise<{ ok: boolean; error?: string }>
  calls: string[]
}

async function connect(scopes: string[]): Promise<Client> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  const host = new WsHost(
    wss,
    undefined,
    {
      redeem: () => ({ ok: false }),
      authenticate: (session) => (session === 'device' ? { id: 'device-1', scopes: scopes as never } : null),
    },
    true,
  )
  const calls: string[] = []
  for (const ch of ['settings:get', 'settings:set', 'settings:remove']) {
    host.handle(ch, (key: unknown) => {
      calls.push(`${ch} ${String(key)}`)
      return null
    })
  }
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
  const ws = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}/?auth=frame`)
  cleanups.push(() => {
    ws.close()
    host.dispose()
    wss.close()
  })
  const pending = new Map<number, (v: { ok: boolean; error?: string }) => void>()
  let authed: () => void = () => {}
  const authedP = new Promise<void>((resolve) => (authed = resolve))
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString())
    if (frame.k === 'authed') authed()
    if (frame.k === 'res') pending.get(frame.id)?.(frame)
  })
  await new Promise<void>((resolve) => ws.on('open', () => resolve()))
  ws.send(JSON.stringify({ k: 'auth', session: 'device' }))
  await authedP
  let id = 0
  return {
    calls,
    call: (ch, args) =>
      new Promise((resolve) => {
        id += 1
        pending.set(id, resolve)
        ws.send(JSON.stringify({ k: 'req', id, ch, args }))
      }),
  }
}

const PROTECTED_SAMPLES = [
  'deviceSessions',
  'devicePairingCode',
  'mobilePairing.enabled',
  'mobilePairing.token',
  'mobilePairing.port',
  'mobilePairing.host',
  'pushTokens',
  'opencode.env.OPENAI_API_KEY',
  'google.clientSecret',
]

describe('device-auth settings over WsHost', () => {
  it('refuses a chat-scoped device every read and write of a protected key', async () => {
    const phone = await connect(['chat'])
    for (const key of PROTECTED_SAMPLES) {
      for (const [ch, args] of [
        ['settings:set', [key, '[]']],
        ['settings:remove', [key]],
        ['settings:get', [key]],
      ] as const) {
        const res = await phone.call(ch, [...args])
        expect({ ch, key, ok: res.ok }).toEqual({ ch, key, ok: false })
        expect(res.error).toMatch(/not permitted/)
      }
    }
    expect(phone.calls).toEqual([])
  })

  it('lets an admin-scoped device read and write them', async () => {
    const desktop = await connect([...FULL_SCOPES])
    for (const key of PROTECTED_SAMPLES) {
      expect((await desktop.call('settings:set', [key, '[]'])).ok).toBe(true)
      expect((await desktop.call('settings:get', [key])).ok).toBe(true)
    }
  })

  it('leaves ordinary settings open to the phone', async () => {
    const phone = await connect(['chat'])
    expect((await phone.call('settings:get', ['chat.defaultRuntimeMode'])).ok).toBe(true)
    expect((await phone.call('settings:set', ['ui.theme', 'dark'])).ok).toBe(true)
    expect((await phone.call('settings:get', ['google.clientId'])).ok).toBe(true)
  })
})

describe('protected settings families', () => {
  it('gates every listed family for both read and write', () => {
    // Iterates the real list, so dropping an entry fails a family test below
    // rather than passing silently here.
    for (const family of ADMIN_ONLY_SETTING_FAMILIES) {
      const key = family.endsWith('.') ? `${family}ANY` : family
      expect(isSettingWriteAllowed(PHONE_SCOPES, key)).toBe(false)
      expect(isSettingReadAllowed(PHONE_SCOPES, key)).toBe(false)
      expect(isSettingWriteAllowed(FULL_SCOPES, key)).toBe(true)
      expect(isSettingReadAllowed(FULL_SCOPES, key)).toBe(true)
    }
  })

  it('names every device-auth and credential family', () => {
    expect([...ADMIN_ONLY_SETTING_FAMILIES].sort()).toEqual(
      [
        'deviceSessions',
        'devicePairingCode',
        'mobilePairing.',
        'pushTokens',
        'opencode.env.',
        'google.clientSecret',
      ].sort(),
    )
  })

  it('covers a future key in a prefix family and a project override of a protected key', () => {
    expect(isSettingWriteAllowed(PHONE_SCOPES, 'mobilePairing.somethingNew')).toBe(false)
    expect(isSettingReadAllowed(PHONE_SCOPES, projectOverrideKey('/repo', 'deviceSessions' as never))).toBe(false)
    expect(isSettingsFrameAllowed(PHONE_SCOPES, 'settings:get', ['devicePairingCode', '/repo'])).toBe(false)
    expect(isSettingsFrameAllowed(PHONE_SCOPES, 'settings:project-override-set', ['/repo', 'pushTokens', '[]'])).toBe(
      false,
    )
  })

  it('does not match a key that merely starts with a family name', () => {
    expect(isSettingReadAllowed(PHONE_SCOPES, 'deviceSessionsView')).toBe(true)
    expect(isSettingReadAllowed(PHONE_SCOPES, 'mobilePairingHint')).toBe(true)
  })
})
