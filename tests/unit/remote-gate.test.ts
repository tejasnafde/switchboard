import { describe, it, expect } from 'vitest'
import {
  sanitizeThreadId,
  pickForwardableCreds,
  remoteBlockedProviderLabel,
  FORWARDABLE_OAUTH_FILES,
  REQUIRED_OAUTH_FILE,
} from '../../src/main/provider/remote-gate'

describe('sanitizeThreadId', () => {
  it('keeps safe chars untouched', () => {
    expect(sanitizeThreadId('abc-123_XYZ.foo')).toBe('abc-123_XYZ.foo')
  })

  it('replaces path separators and traversal with underscores', () => {
    expect(sanitizeThreadId('../../etc/passwd')).toBe('.._.._etc_passwd')
    expect(sanitizeThreadId('a/b\\c')).toBe('a_b_c')
  })

  it('replaces spaces and other unsafe chars', () => {
    expect(sanitizeThreadId('thread id!$*')).toBe('thread_id___')
  })
})

describe('pickForwardableCreds', () => {
  it('returns empty when the required file is missing', () => {
    expect(pickForwardableCreds({ 'settings.json': '{}' })).toEqual({})
  })

  it('returns empty when the required file is blank', () => {
    expect(pickForwardableCreds({ [REQUIRED_OAUTH_FILE]: '' })).toEqual({})
  })

  it('keeps the required file alone when others absent', () => {
    expect(pickForwardableCreds({ [REQUIRED_OAUTH_FILE]: '{"t":1}' })).toEqual({
      [REQUIRED_OAUTH_FILE]: '{"t":1}',
    })
  })

  it('keeps required + optional non-empty files', () => {
    const out = pickForwardableCreds({
      [REQUIRED_OAUTH_FILE]: '{"t":1}',
      'settings.json': '{"a":2}',
    })
    expect(out).toEqual({ [REQUIRED_OAUTH_FILE]: '{"t":1}', 'settings.json': '{"a":2}' })
  })

  it('drops empty optional files and unknown files', () => {
    const out = pickForwardableCreds({
      [REQUIRED_OAUTH_FILE]: '{"t":1}',
      'settings.json': '',
      'secret.key': 'nope',
    })
    expect(out).toEqual({ [REQUIRED_OAUTH_FILE]: '{"t":1}' })
    expect(FORWARDABLE_OAUTH_FILES).toContain('settings.json')
  })
})

describe('remoteBlockedProviderLabel', () => {
  it('allows claude on remote (null label)', () => {
    expect(remoteBlockedProviderLabel('claude')).toBeNull()
  })

  it('blocks codex and opencode with readable labels', () => {
    expect(remoteBlockedProviderLabel('codex')).toBe('Codex')
    expect(remoteBlockedProviderLabel('opencode')).toBe('OpenCode')
  })
})
