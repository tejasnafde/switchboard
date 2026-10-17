/**
 * tests/fixtures/connection-security-copy.json is the copy native Android keeps
 * in ConnectionSecurityCopy.kt (checked by ConnectionSecurityTest).
 * After changing CONNECTION_SECURITY_COPY, regenerate it with
 *
 *   SB_UPDATE_FIXTURES=1 npx vitest run tests/unit/connection-security.test.ts
 *
 * and update the Kotlin copy until its test passes.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONNECTION_SECURITY_COPY,
  connectionSecurity,
  fillCopy,
  fingerprintInUrl,
  needsAttention,
  securityLabel,
  shortFingerprint,
  showsFingerprint,
  showsLock,
  type ConnectionSecurityInput,
} from '../../src/shared/connection-security'

const FP = '7c0e51b2' + 'a'.repeat(56)
const FIXTURE = join(__dirname, '../fixtures/connection-security-copy.json')

const ws = (url: string, extra: Partial<ConnectionSecurityInput> = {}) =>
  connectionSecurity({ kind: 'ws', url, canPin: true, refused: false, certificateChanged: false, ...extra })

describe('shortFingerprint', () => {
  it('is the first 8 lowercase hex characters of a SHA-256', () => {
    expect(shortFingerprint(FP)).toBe('7c0e51b2')
    expect(shortFingerprint(FP.toUpperCase())).toBe('7c0e51b2')
  })

  it('is null for anything that is not a fingerprint', () => {
    expect(shortFingerprint(undefined)).toBeNull()
    expect(shortFingerprint('')).toBeNull()
    expect(shortFingerprint('7c0e51b2')).toBeNull()
    expect(shortFingerprint('z'.repeat(64))).toBeNull()
  })
})

describe('fingerprintInUrl', () => {
  it('reads fp from a saved or scanned address', () => {
    expect(fingerprintInUrl(`ws://10.0.4.17:8765?fp=${FP}`)).toBe(FP)
    expect(fingerprintInUrl(`ws://10.0.4.17:8765?pair=abc&fp=${FP.toUpperCase()}`)).toBe(FP)
    expect(fingerprintInUrl('ws://10.0.4.17:8765?pair=abc')).toBeNull()
    expect(fingerprintInUrl('ws://10.0.4.17:8765?fp=nope')).toBeNull()
  })
})

describe('connectionSecurity', () => {
  it('reads a pinned address as encrypted only when the app can pin', () => {
    expect(ws(`ws://192.168.1.24:8765?fp=${FP}`)).toBe('pinned')
    expect(ws(`ws://192.168.1.24:8765?fp=${FP}`, { canPin: false })).toBe('plain')
  })

  it('reads loopback and the emulator host as local, any other host as plain', () => {
    expect(ws('ws://127.0.0.1:8765')).toBe('local')
    expect(ws('ws://localhost:8765')).toBe('local')
    expect(ws('ws://10.0.2.2:8765')).toBe('local')
    expect(ws('ws://10.0.4.17:8765')).toBe('plain')
  })

  it('puts a certificate change before a refusal, and IAP before both', () => {
    expect(ws('ws://10.0.4.17:8765', { refused: true })).toBe('refused')
    expect(ws(`ws://10.0.4.17:8765?fp=${FP}`, { refused: true, certificateChanged: true })).toBe('certificate-changed')
    expect(connectionSecurity({ kind: 'iap', canPin: true, refused: true, certificateChanged: true })).toBe('iap')
  })
})

describe('row rules', () => {
  it('lists refused, certificate-changed and error rows under Needs attention', () => {
    expect(needsAttention('refused', 'disconnected')).toBe(true)
    expect(needsAttention('certificate-changed', 'error')).toBe(true)
    expect(needsAttention('pinned', 'error')).toBe(true)
    expect(needsAttention('pinned', 'connected')).toBe(false)
    expect(needsAttention('local', 'disconnected')).toBe(false)
  })

  it('shows the fingerprint only where something is pinned, and the lock only where it is encrypted', () => {
    expect(['pinned', 'certificate-changed'].every((s) => showsFingerprint(s as never))).toBe(true)
    expect(['local', 'plain', 'iap', 'refused'].some((s) => showsFingerprint(s as never))).toBe(false)
    expect(showsLock('pinned') && showsLock('iap')).toBe(true)
    expect(['local', 'plain', 'refused', 'certificate-changed'].some((s) => showsLock(s as never))).toBe(false)
  })

  it('labels every state', () => {
    expect(securityLabel('pinned')).toBe('Encrypted')
    expect(securityLabel('local')).toBe('Not encrypted, local only')
    expect(securityLabel('iap')).toBe('Cloud IAP')
    expect(securityLabel('refused')).toBe('Needs encryption')
    expect(securityLabel('certificate-changed')).toBe('Certificate changed')
  })

  it('fills placeholders and leaves unknown ones', () => {
    expect(fillCopy('certificateUnexpectedBody', { fingerprint: '7c0e51b2' })).toContain('if it still shows 7c0e51b2,')
    expect(fillCopy('liveCount', { live: 3, total: 5 })).toBe('3 of 5')
    expect(fillCopy('certificateChangedBody')).toContain('{label}')
  })
})

describe('copy fixture', () => {
  it('matches CONNECTION_SECURITY_COPY', () => {
    const expected = `${JSON.stringify(CONNECTION_SECURITY_COPY, null, 2)}\n`
    if (process.env.SB_UPDATE_FIXTURES === '1') writeFileSync(FIXTURE, expected)
    expect(
      readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n'),
      'tests/fixtures/connection-security-copy.json is stale: run SB_UPDATE_FIXTURES=1 npx vitest run tests/unit/connection-security.test.ts',
    ).toBe(expected)
  })
})
