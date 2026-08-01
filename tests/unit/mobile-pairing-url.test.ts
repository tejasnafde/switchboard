/**
 * The pairing payload.
 *
 * A phone that takes the shared token when a one-time code was offered opts
 * itself back into the credential the code exists to replace, so the precedence
 * here is load-bearing rather than cosmetic.
 */
import { describe, it, expect } from 'vitest'
import { parsePairingUrl } from '../../apps/mobile/src/lib/pairing'

describe('parsePairingUrl', () => {
  it('reads a one-time pairing code', () => {
    expect(parsePairingUrl('ws://192.168.1.8:8765?pair=abc123')).toEqual({
      url: 'ws://192.168.1.8:8765',
      token: undefined,
      pairing: 'abc123',
    })
  })

  it('still reads a legacy shared token, so an older desktop can be paired', () => {
    expect(parsePairingUrl('ws://192.168.1.8:8765?token=shared')).toEqual({
      url: 'ws://192.168.1.8:8765',
      token: 'shared',
      pairing: undefined,
    })
  })

  it('prefers the code when a desktop offers both', () => {
    const parsed = parsePairingUrl('ws://h:8765?token=shared&pair=abc123')
    expect(parsed?.pairing).toBe('abc123')
    expect(parsed?.token).toBeUndefined()
  })

  it('accepts a bare address with no credential', () => {
    expect(parsePairingUrl('ws://h:8765')).toEqual({ url: 'ws://h:8765', token: undefined, pairing: undefined })
  })

  it('rejects anything that is not a websocket address', () => {
    expect(parsePairingUrl('https://example.com')).toBeNull()
    expect(parsePairingUrl('not a url')).toBeNull()
    expect(parsePairingUrl('')).toBeNull()
  })
})
