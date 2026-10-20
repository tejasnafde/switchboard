/**
 * A device's custom name: stored on its session, shown in place of the name
 * the phone reports, cleared back to it, and settable only from the desktop.
 */
import { createMigratedDb } from './helpers/test-db'
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

const sessions = await import('../../src/main/backend/device-sessions')
const { DEVICE_NAME_MAX, FULL_SCOPES, PHONE_SCOPES, deviceDisplayName, isChannelAllowed } =
  await import('../../src/shared/device-auth')
const { AppChannels } = await import('../../src/shared/ipc-channels')

const IPHONE = { installId: 'b71e4d02-9a6f-4c31-8e5d-2f0a9c7b1d44', name: 'iPhone', platform: 'ios' as const }

let token = ''

function pair(): string {
  const { code } = sessions.createPairingCode()
  const result = sessions.redeemPairingCode(code, 'iPhone', [...PHONE_SCOPES], { device: IPHONE })
  token = result.session ?? ''
  return sessions.listSessionViews()[0].id
}

beforeEach(() => {
  createMigratedDb()
})

describe('renameSession', () => {
  it('stores a trimmed custom name that overrides the reported one', () => {
    const id = pair()
    expect(sessions.renameSession(id, "  Tejas's iPhone  ")).toBe(true)
    const [view] = sessions.listSessionViews()
    expect(view.customName).toBe("Tejas's iPhone")
    expect(view.name).toBe('iPhone')
    expect(deviceDisplayName(view)).toBe("Tejas's iPhone")
  })

  it('survives the phone reporting its identity again', () => {
    const id = pair()
    sessions.renameSession(id, 'Work phone')
    expect(sessions.authenticateSession(token, { device: { ...IPHONE, name: 'iPhone 2' } })).not.toBeNull()
    const [view] = sessions.listSessionViews()
    expect(view.name).toBe('iPhone 2')
    expect(view.customName).toBe('Work phone')
  })

  it('clears with null or blank text, so the reported name shows again', () => {
    const id = pair()
    sessions.renameSession(id, 'Work phone')
    sessions.renameSession(id, null)
    expect(sessions.listSessionViews()[0]).not.toHaveProperty('customName')
    sessions.renameSession(id, 'Work phone')
    sessions.renameSession(id, '   ')
    const [view] = sessions.listSessionViews()
    expect(view).not.toHaveProperty('customName')
    expect(deviceDisplayName(view)).toBe('iPhone')
  })

  it('bounds the length', () => {
    const id = pair()
    sessions.renameSession(id, 'x'.repeat(500))
    expect(sessions.listSessionViews()[0].customName).toHaveLength(DEVICE_NAME_MAX)
  })

  it('refuses an unknown or revoked session', () => {
    const id = pair()
    expect(sessions.renameSession('nope', 'x')).toBe(false)
    sessions.revokeSession(id)
    expect(sessions.renameSession(id, 'x')).toBe(false)
  })

  it('falls back to the pairing label when nothing is reported', () => {
    expect(deviceDisplayName({ label: 'device' })).toBe('device')
  })
})

describe('rename channel', () => {
  it('is desktop only: a phone session cannot call it', () => {
    expect(AppChannels.MOBILE_DEVICE_RENAME).toBe('mobile-pairing:rename')
    expect(isChannelAllowed(PHONE_SCOPES, AppChannels.MOBILE_DEVICE_RENAME)).toBe(false)
    expect(isChannelAllowed(FULL_SCOPES, AppChannels.MOBILE_DEVICE_RENAME)).toBe(true)
  })
})
