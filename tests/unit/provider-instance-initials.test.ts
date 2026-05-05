/**
 * `providerInstanceInitials` — pure helper that produces the 2-character
 * badge shown in the instance rail / picker chip / settings card. Lifted
 * from t3code's helper of the same name.
 */
import { describe, it, expect } from 'vitest'
import { providerInstanceInitials } from '../../src/shared/providerInstanceInitials'

describe('providerInstanceInitials', () => {
  it('returns first letter of two leading words, uppercased', () => {
    expect(providerInstanceInitials('Claude Work')).toBe('CW')
    expect(providerInstanceInitials('claude personal')).toBe('CP')
  })

  it('splits on whitespace, hyphen, and underscore', () => {
    expect(providerInstanceInitials('claude-frontier')).toBe('CF')
    expect(providerInstanceInitials('codex_team')).toBe('CT')
  })

  it('falls back to the first two chars when only one word', () => {
    expect(providerInstanceInitials('Default')).toBe('DE')
    expect(providerInstanceInitials('a')).toBe('A')
  })

  it('returns ?? for empty / whitespace-only input', () => {
    expect(providerInstanceInitials('')).toBe('??')
    expect(providerInstanceInitials('   ')).toBe('??')
  })

  it('ignores extra whitespace and empty segments', () => {
    expect(providerInstanceInitials('  Tech   Team  ')).toBe('TT')
    expect(providerInstanceInitials('a---b')).toBe('AB')
  })
})
