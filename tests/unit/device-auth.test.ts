/**
 * Per-device session rules.
 *
 * The credential these govern grants access to a machine the user owns, so the
 * interesting cases are the ones where a check quietly stops meaning anything:
 * a scope list that lets an unlisted channel through, a pairing code that
 * outlives its moment, a revoked device that still connects.
 */
import { describe, it, expect } from 'vitest'
import {
  isChannelAllowed,
  isPairingCodeUsable,
  isRevoked,
  toView,
  FULL_SCOPES,
  PHONE_SCOPES,
  PAIRING_CODE_TTL_MS,
  type DeviceSession,
} from '../../src/shared/device-auth'

describe('isChannelAllowed', () => {
  it('keeps a phone session away from spawning a terminal', () => {
    // The phone app has no terminal UI, so this is the difference between a
    // stolen credential reading conversations and running commands.
    expect(isChannelAllowed(PHONE_SCOPES, 'terminal:create')).toBe(false)
    expect(isChannelAllowed(PHONE_SCOPES, 'terminal:data')).toBe(false)
  })

  it('lets a phone session do everything it actually needs', () => {
    for (const channel of [
      'provider:send-turn',
      'app:get-projects',
      'files:list-dir',
      'git:file-diff',
      'push:register',
    ]) {
      expect(isChannelAllowed(PHONE_SCOPES, channel)).toBe(true)
    }
  })

  it('allows a channel nobody thought to list', () => {
    // Deliberate. Deny-by-default needs a hand-maintained list of every
    // channel, and missing one breaks a feature silently for paired devices
    // only. The gate covers what is dangerous, not what is known.
    expect(isChannelAllowed(PHONE_SCOPES, 'somethingNew:added-later')).toBe(true)
  })

  it('grants a full session the terminal', () => {
    expect(isChannelAllowed(FULL_SCOPES, 'terminal:create')).toBe(true)
  })

  it('denies everything dangerous to a session holding no scopes at all', () => {
    expect(isChannelAllowed([], 'terminal:create')).toBe(false)
  })
})

describe('isPairingCodeUsable', () => {
  const now = 1_000_000

  it('accepts a fresh unused code', () => {
    expect(isPairingCodeUsable({ code: 'x', expiresAt: now + 1 }, now)).toBe(true)
  })

  it('refuses a code that has already been redeemed', () => {
    // A QR photographed over a shoulder is worth nothing once the intended
    // device has used it.
    expect(isPairingCodeUsable({ code: 'x', expiresAt: now + 1_000, usedAt: now - 1 }, now)).toBe(false)
  })

  it('refuses an expired code', () => {
    expect(isPairingCodeUsable({ code: 'x', expiresAt: now }, now)).toBe(false)
  })

  it('refuses a missing code, so an unpaired backend cannot be paired blind', () => {
    expect(isPairingCodeUsable(null, now)).toBe(false)
  })

  it('expires within minutes, not hours', () => {
    // A long-lived code is a second standing credential, which is the thing
    // this design exists to remove.
    expect(PAIRING_CODE_TTL_MS).toBeLessThanOrEqual(10 * 60_000)
  })
})

describe('sessions', () => {
  const session: DeviceSession = {
    id: 'd1',
    tokenHash: 'abc',
    label: 'Pixel',
    scopes: ['chat'],
    createdAt: 1,
    lastSeenAt: 2,
  }

  it('reports a revoked device as revoked', () => {
    expect(isRevoked(session)).toBe(false)
    expect(isRevoked({ ...session, revokedAt: 5 })).toBe(true)
  })

  it('never exposes the token hash to the UI', () => {
    const view = toView(session)
    expect(view).not.toHaveProperty('tokenHash')
    expect(JSON.stringify(view)).not.toContain('abc')
  })
})
