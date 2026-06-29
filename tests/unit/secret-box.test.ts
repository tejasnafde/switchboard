import { describe, it, expect } from 'vitest'
import { seal, unseal } from '../../src/main/crypto/secret-box'

describe('secret-box (passphrase AES-256-GCM)', () => {
  it('round-trips plaintext with the right passphrase', () => {
    const secret = 'correct horse battery staple'
    const blob = seal('{"API_KEY":"sk-123"}', secret)
    expect(unseal(blob, secret)).toBe('{"API_KEY":"sk-123"}')
  })

  it('produces ciphertext that does not leak the plaintext', () => {
    const blob = seal('super-secret-token', 'pw')
    expect(blob.toString('utf-8')).not.toContain('super-secret-token')
  })

  it('uses a fresh salt+iv each time (different ciphertext for same input)', () => {
    const a = seal('same', 'pw')
    const b = seal('same', 'pw')
    expect(a.equals(b)).toBe(false)
    expect(unseal(a, 'pw')).toBe('same')
    expect(unseal(b, 'pw')).toBe('same')
  })

  it('throws (GCM tag mismatch) on the wrong passphrase', () => {
    const blob = seal('secret', 'right')
    expect(() => unseal(blob, 'wrong')).toThrow()
  })
})
