/**
 * Push suppression while the user is at the machine.
 *
 * The older rule was a per-thread viewing claim keyed off window focus. It
 * covers one thread, so running three agents still buzzed the phone about two
 * of them, and it counted Switchboard sitting behind an editor as having walked
 * away. Presence answers the question actually being asked.
 */
import { describe, it, expect } from 'vitest'
import { isUserPresent, PRESENCE_IDLE_LIMIT_MS } from '../../src/shared/push-presence'

describe('isUserPresent', () => {
  it('is present while there has been recent input', () => {
    expect(isUserPresent({ idleMs: () => 0 })).toBe(true)
    expect(isUserPresent({ idleMs: () => PRESENCE_IDLE_LIMIT_MS - 1 })).toBe(true)
  })

  it('is away once idle past the limit', () => {
    expect(isUserPresent({ idleMs: () => PRESENCE_IDLE_LIMIT_MS })).toBe(false)
    expect(isUserPresent({ idleMs: () => 10 * 60_000 })).toBe(false)
  })

  it('is away when there is no probe at all', () => {
    // A headless server has no one at it. Guessing "present" there would
    // silently disable push for the case it exists to serve.
    expect(isUserPresent(null)).toBe(false)
  })

  it('tolerates reading a diff without deciding you left', () => {
    // A threshold in seconds would trip while reading and reintroduce the noise
    // this removes.
    expect(PRESENCE_IDLE_LIMIT_MS).toBeGreaterThanOrEqual(60_000)
  })
})
