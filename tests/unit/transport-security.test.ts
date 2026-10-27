/** The pairing payload's certificate pin and the store builds' cleartext rule. */
import { describe, expect, it } from 'vitest'
import { cleartextRefusal, isLoopbackHost, withCertPin } from '../../src/shared/transport-security'
import { parsePairingUrl } from '../../apps/mobile/src/lib/pairing'

const FP = 'ab'.repeat(32)

describe('withCertPin', () => {
  it('appends the pin to the pairing URL, and leaves it alone without one', () => {
    expect(withCertPin('ws://10.0.0.5:8765?pair=c0de', FP)).toBe(`ws://10.0.0.5:8765?pair=c0de&fp=${FP}`)
    expect(withCertPin('ws://10.0.0.5:8765', FP)).toBe(`ws://10.0.0.5:8765?fp=${FP}`)
    expect(withCertPin('ws://10.0.0.5:8765?pair=c0de', null)).toBe('ws://10.0.0.5:8765?pair=c0de')
  })

  it('round-trips through the phone parser, which keeps the pin and drops the code from the saved URL', () => {
    expect(parsePairingUrl(withCertPin('ws://10.0.0.5:8765?pair=c0de', FP))).toEqual({
      url: `ws://10.0.0.5:8765?fp=${FP}`,
      token: undefined,
      pairing: 'c0de',
    })
  })
})

describe('parsePairingUrl with a pin', () => {
  it('normalises the pin to lowercase', () => {
    expect(parsePairingUrl(`ws://h:8765?pair=x&fp=${FP.toUpperCase()}`)?.url).toBe(`ws://h:8765?fp=${FP}`)
  })

  it('refuses a malformed pin rather than silently dropping it', () => {
    expect(parsePairingUrl('ws://h:8765?pair=x&fp=deadbeef')).toBeNull()
  })
})

describe('cleartextRefusal', () => {
  it('refuses plain ws:// to a remote host', () => {
    expect(cleartextRefusal('ws://192.168.1.8:8765')).toMatch(/encrypted connection/)
    expect(cleartextRefusal(`ws://mac.local:8765?fp=${FP}`)).toMatch(/encrypted connection/)
  })

  it('allows wss://, loopback and the Android emulator host', () => {
    expect(cleartextRefusal('wss://192.168.1.8:8765')).toBeNull()
    expect(cleartextRefusal('ws://127.0.0.1:8765')).toBeNull()
    expect(cleartextRefusal('ws://localhost:8765')).toBeNull()
    expect(cleartextRefusal('ws://[::1]:8765')).toBeNull()
    expect(cleartextRefusal('ws://10.0.2.2:8765')).toBeNull()
  })

  it('does not treat a lookalike host as loopback', () => {
    expect(isLoopbackHost('127.0.0.1.evil.example')).toBe(false)
    expect(isLoopbackHost('localhost.example')).toBe(false)
  })

  it('matches the emulator host exactly, not a near-miss', () => {
    expect(isLoopbackHost('10.0.2.2')).toBe(true)
    expect(isLoopbackHost('10.0.2.20')).toBe(false)
    expect(isLoopbackHost('10.0.2.2.example.com')).toBe(false)
    expect(isLoopbackHost('110.0.2.2')).toBe(false)
    expect(cleartextRefusal('ws://10.0.2.20:8765')).toMatch(/encrypted connection/)
    expect(cleartextRefusal('ws://10.0.2.2.example.com:8765')).toMatch(/encrypted connection/)
    expect(cleartextRefusal('ws://110.0.2.2:8765')).toMatch(/encrypted connection/)
    expect(cleartextRefusal('ws://10.0.2.2@evil.example:8765')).toMatch(/encrypted connection/)
  })
})
