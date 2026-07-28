import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { join, normalize } from 'path'
import {
  claudeKeychainServiceCandidates,
  keychainAccountCandidates,
  parseStoredClaudeCredential,
} from '../../src/main/provider/usage/claude-keychain'

const BASE = 'Claude Code-credentials'

/**
 * Expected service name for a dir. Used where the dir goes through `join` or
 * `normalize` first, since those emit backslashes on Windows and so produce a
 * different digest for the same logical path - the assertion has to be
 * computed with the same primitives rather than hardcoded to POSIX.
 */
function serviceFor(dir: string): string {
  return `${BASE}-${createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8)}`
}

describe('claudeKeychainServiceCandidates', () => {
  it('uses the bare service name only when CLAUDE_CONFIG_DIR is unset', () => {
    expect(claudeKeychainServiceCandidates(null)).toEqual([BASE])
    expect(claudeKeychainServiceCandidates(undefined)).toEqual([BASE])
    expect(claudeKeychainServiceCandidates('   ')).toEqual([BASE])
  })

  it('matches the real keychain entries on this machine', () => {
    // Golden values verified against `security dump-keychain`. If the CLI ever
    // changes its derivation these break loudly instead of silently reading
    // the wrong account's quota.
    const cases: Array<[string, string]> = [
      ['/Users/tejas/.claude-tejas', `${BASE}-43660b83`],
      ['/Users/tejas/.claude-tech-team', `${BASE}-630643ea`],
      ['/Users/tejas/.claude-akshaya', `${BASE}-6712bfb6`],
      ['/Users/tejas/.claude-backend', `${BASE}-80adaa26`],
      ['/Users/tejas/.claude-pankaj', `${BASE}-d165bd41`],
    ]
    for (const [dir, expected] of cases) {
      expect(claudeKeychainServiceCandidates(dir)[0]).toBe(expected)
    }
  })

  it('never returns the bare name once a dir is set', () => {
    // "points at the default dir" is not the same as "unset" - the CLI
    // hashes whenever the variable is present.
    expect(claudeKeychainServiceCandidates('/Users/tejas/.claude')).not.toContain(BASE)
  })

  it('covers a trailing separator, which changes the digest', () => {
    const withSep = claudeKeychainServiceCandidates('/Users/tejas/.claude-tejas/')
    expect(withSep).toContain(`${BASE}-43660b83`)
    // The as-given form is tried first, since that is what our spawn env holds.
    expect(withSep[0]).not.toBe(`${BASE}-43660b83`)
  })

  it('covers an unexpanded tilde, which an env overlay can produce', () => {
    // applyEnvOverlay does no tilde expansion, so a literal "~/..." can reach
    // the spawn env and would have been hashed that way at login time.
    const candidates = claudeKeychainServiceCandidates('~/.claude-tejas', '/Users/tejas')
    expect(candidates).toContain(`${BASE}-d2b02557`) // hash of the literal string
    expect(candidates).toContain(serviceFor(join('/Users/tejas', '.claude-tejas')))
  })

  it('covers an unnormalised path', () => {
    const messy = '/Users/tejas//.claude-tejas'
    expect(claudeKeychainServiceCandidates(messy)).toContain(serviceFor(normalize(messy)))
  })

  it('covers NFD-composed non-ASCII directory names', () => {
    const nfc = '/Users/tejas/.claude-café'.normalize('NFC')
    const nfd = '/Users/tejas/.claude-café'.normalize('NFD')
    const fromNfc = claudeKeychainServiceCandidates(nfc)
    const fromNfd = claudeKeychainServiceCandidates(nfd)
    // Whichever form the user typed, both digests are attempted.
    expect(fromNfc.some((c) => fromNfd.includes(c))).toBe(true)
    expect(fromNfc.length).toBeGreaterThan(1)
  })

  it('returns a deduped, bounded, stable list', () => {
    const candidates = claudeKeychainServiceCandidates('/Users/tejas/.claude-tejas')
    expect(new Set(candidates).size).toBe(candidates.length)
    expect(candidates.length).toBeLessThanOrEqual(8)
    expect(candidates).toEqual(claudeKeychainServiceCandidates('/Users/tejas/.claude-tejas'))
  })
})

describe('keychainAccountCandidates', () => {
  it('tries the env user first and always ends with an unscoped attempt', () => {
    const out = keychainAccountCandidates('tejas')
    expect(out[0]).toBe('tejas')
    expect(out[out.length - 1]).toBeUndefined()
  })

  it('still offers the unscoped attempt when USER is absent', () => {
    expect(keychainAccountCandidates(undefined)).toContain(undefined)
  })
})

describe('parseStoredClaudeCredential', () => {
  const valid = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-example',
      refreshToken: 'refresh',
      expiresAt: 1785200000000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'team',
    },
  })

  it('extracts the fields the usage probe needs', () => {
    const parsed = parseStoredClaudeCredential(valid)
    expect(parsed).toMatchObject({
      accessToken: 'sk-ant-oat01-example',
      expiresAtMs: 1785200000000,
      subscriptionType: 'team',
    })
    expect(parsed?.scopes).toContain('user:profile')
  })

  it('returns null for anything that is not a credential payload', () => {
    expect(parseStoredClaudeCredential('')).toBeNull()
    expect(parseStoredClaudeCredential('not json')).toBeNull()
    expect(parseStoredClaudeCredential('{}')).toBeNull()
    expect(parseStoredClaudeCredential(JSON.stringify({ claudeAiOauth: {} }))).toBeNull()
    expect(parseStoredClaudeCredential(JSON.stringify({ claudeAiOauth: { accessToken: '' } }))).toBeNull()
  })

  it('tolerates a payload with no expiry or scopes', () => {
    const parsed = parseStoredClaudeCredential(JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }))
    expect(parsed).toMatchObject({ accessToken: 'tok', expiresAtMs: null, subscriptionType: null })
    expect(parsed?.scopes).toEqual([])
  })
})
