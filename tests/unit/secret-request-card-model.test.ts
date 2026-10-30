import { describe, expect, it } from 'vitest'
import {
  asksForProviderKey,
  isSecretCardKeyTarget,
  secretAnswerErrorText,
  secretFooterText,
  secretLineState,
  secretTooShortToMask,
  secretNameFromResultTitle,
  secretTimeLeftText,
  secretValueSavable,
  splitInstructionUrls,
  trimSecretValue,
  utf8ByteLength,
} from '../../src/renderer/components/chat/secret-request-card-model'
import { CLEARTEXT_SECRET_REFUSAL } from '../../src/shared/transport-security'
import { agentSecretStatus, isAgentSecretAnswer, type AgentSecretView } from '../../src/shared/agent-secret-request'

const MIN = 60_000
const HOUR = 60 * MIN

describe('secret card texts', () => {
  it('words the footer from the ttl and names an SSH machine', () => {
    expect(secretFooterText('24h')).toBe(
      "Kept out of chat, in a private file this agent's commands can read for 24 hours.",
    )
    expect(secretFooterText('4h', 'geoiq-ssg-dev-in')).toBe(
      "Kept out of chat, in a private file this agent's commands can read for 4 hours, on geoiq-ssg-dev-in.",
    )
    expect(secretFooterText('1h')).toContain('for 1 hour.')
    expect(secretFooterText('15m')).toContain('for 15 minutes.')
  })

  it('counts down in hours, then minutes under an hour', () => {
    expect(secretTimeLeftText(24 * HOUR, 0)).toBe('24 h left')
    expect(secretTimeLeftText(23 * HOUR + 59 * MIN, 0)).toBe('23 h left')
    expect(secretTimeLeftText(HOUR, 0)).toBe('1 h left')
    expect(secretTimeLeftText(47 * MIN, 0)).toBe('47 min left')
    expect(secretTimeLeftText(20_000, 0)).toBe('1 min left')
    expect(secretTimeLeftText(0, 0)).toBeNull()
    expect(secretTimeLeftText(5, 10)).toBeNull()
  })

  it('reads the name back from the result row title', () => {
    expect(secretNameFromResultTitle('Secret TAILSCALE_AUTHKEY')).toBe('TAILSCALE_AUTHKEY')
    expect(secretNameFromResultTitle('ODD')).toBe('ODD')
  })
})

describe('the value checks', () => {
  it('trims trailing spaces and one trailing newline only', () => {
    expect(trimSecretValue('sb-test-not-a-secret')).toEqual({ value: 'sb-test-not-a-secret', trimmed: false })
    expect(trimSecretValue('abc  ')).toEqual({ value: 'abc', trimmed: true })
    expect(trimSecretValue('abc\n')).toEqual({ value: 'abc', trimmed: true })
    expect(trimSecretValue('abc \r\n')).toEqual({ value: 'abc', trimmed: true })
    expect(trimSecretValue('abc\n\n')).toEqual({ value: 'abc\n', trimmed: true })
    expect(trimSecretValue('  abc')).toEqual({ value: '  abc', trimmed: false })
  })

  it('counts UTF-8 bytes like TextEncoder', () => {
    for (const s of ['', 'a', 'é', '€', '😀', 'a😀é€', '\ud800x', 'x\udc00'])
      expect(utf8ByteLength(s)).toBe(new TextEncoder().encode(s).length)
  })

  it('allows 1 byte to 16 KiB after the trim', () => {
    expect(secretValueSavable('')).toBe(false)
    expect(secretValueSavable('   \n')).toBe(false)
    expect(secretValueSavable('x')).toBe(true)
    expect(secretValueSavable('x'.repeat(16 * 1024))).toBe(true)
    expect(secretValueSavable(`${'x'.repeat(16 * 1024)}  `)).toBe(true)
    expect(secretValueSavable('x'.repeat(16 * 1024 + 1))).toBe(false)
    expect(secretValueSavable('€'.repeat(5462))).toBe(false)
  })
})

describe('instructions', () => {
  it('splits URLs into a bold host and the rest, and keeps the text around them', () => {
    expect(
      splitInstructionUrls('Create it at https://login.tailscale.com/admin/settings/keys, then Generate auth key.'),
    ).toEqual([
      { kind: 'text', text: 'Create it at ' },
      {
        kind: 'url',
        url: 'https://login.tailscale.com/admin/settings/keys',
        host: 'login.tailscale.com',
        rest: '/admin/settings/keys',
      },
      { kind: 'text', text: ', then Generate auth key.' },
    ])
  })

  it('shows the real host, not a user part, and leaves plain text alone', () => {
    const [, url] = splitInstructionUrls('see https://dashboard.example.com@evil.example/keys.')
    expect(url).toMatchObject({ kind: 'url', host: 'evil.example', rest: '/keys' })
    expect(splitInstructionUrls('no links here')).toEqual([{ kind: 'text', text: 'no links here' }])
    expect(splitInstructionUrls('http://x.test')).toEqual([
      { kind: 'url', url: 'http://x.test/', host: 'x.test', rest: '' },
    ])
  })
})

describe('provider keys', () => {
  it('matches a provider key by name or by title words', () => {
    expect(asksForProviderKey('ANTHROPIC_API_KEY', 'Key')).toBe(true)
    expect(asksForProviderKey('MY_KEY', 'OpenAI API key for the eval')).toBe(true)
    expect(asksForProviderKey('TAILSCALE_AUTHKEY', 'Tailscale auth key')).toBe(false)
    expect(asksForProviderKey('MY_OPENAI_API_KEY_COPY', 'Some key')).toBe(false)
  })
})

describe('the collapsed line', () => {
  const view = (patch: Partial<AgentSecretView>): AgentSecretView => ({
    id: 'sec_1',
    name: 'KEY',
    cardId: 'sbsec_1',
    createdAt: 0,
    expiresAt: 10 * HOUR,
    deletedAt: null,
    status: 'live',
    ...patch,
  })

  it('maps the result and the saved secret to one state', () => {
    expect(secretLineState('declined', 'sbsec_1', null, 0)).toEqual({ kind: 'declined' })
    expect(secretLineState('dismissed', 'sbsec_1', null, 0)).toEqual({ kind: 'declined' })
    expect(secretLineState('expired', 'sbsec_1', null, 0)).toEqual({ kind: 'expired' })
    expect(secretLineState('stopped', 'sbsec_1', null, 0)).toEqual({ kind: 'expired' })
    expect(secretLineState('done', 'sbsec_1', null, 0)).toEqual({ kind: 'saved', expiresAt: null, secretId: null })
    expect(secretLineState('done', 'sbsec_1', [view({})], 0)).toEqual({
      kind: 'saved',
      expiresAt: 10 * HOUR,
      secretId: 'sec_1',
    })
    expect(secretLineState('done', 'sbsec_1', [view({})], 11 * HOUR)).toEqual({ kind: 'expired' })
    expect(secretLineState('done', 'sbsec_1', [view({ status: 'deleted', deletedAt: 1 })], 0)).toEqual({
      kind: 'deleted',
    })
    expect(secretLineState('done', 'sbsec_1', [view({ cardId: 'sbsec_2' })], 0)).toEqual({ kind: 'expired' })
  })

  it('reads expired versus deleted from the times', () => {
    expect(agentSecretStatus({ expiresAt: 10, deletedAt: null }, 5)).toBe('live')
    expect(agentSecretStatus({ expiresAt: 10, deletedAt: null }, 10)).toBe('expired')
    expect(agentSecretStatus({ expiresAt: 10, deletedAt: 10 }, 20)).toBe('expired')
    expect(agentSecretStatus({ expiresAt: 10, deletedAt: 4 }, 20)).toBe('deleted')
  })
})

describe('answer shape and key targets', () => {
  it('accepts only { save: string } or { decline: true }', () => {
    expect(isAgentSecretAnswer({ save: 'x' })).toBe(true)
    expect(isAgentSecretAnswer({ decline: true })).toBe(true)
    for (const bad of [null, 'x', [], {}, { save: 1 }, { decline: 1 }, { save: 'x', decline: true }, { other: 1 }])
      expect(isAgentSecretAnswer(bad)).toBe(false)
  })

  it('finds a key target inside a card', () => {
    const inside = { closest: (sel: string) => (sel === '[data-sb-secret-card]' ? {} : null) }
    const outside = { closest: () => null }
    expect(isSecretCardKeyTarget(inside as unknown as EventTarget)).toBe(true)
    expect(isSecretCardKeyTarget(outside as unknown as EventTarget)).toBe(false)
    expect(isSecretCardKeyTarget(null)).toBe(false)
  })
})

describe('short values', () => {
  it('warns at 7 characters and not at 8, counted after the trim', () => {
    expect(secretTooShortToMask('')).toBe(false)
    expect(secretTooShortToMask('abcdefg')).toBe(true)
    expect(secretTooShortToMask('abcdefgh')).toBe(false)
    expect(secretTooShortToMask('abcdefg   \n')).toBe(true)
  })

  it('counts code points, as the matcher does', () => {
    expect(secretTooShortToMask('\u{1F511}'.repeat(7))).toBe(true)
    expect(secretTooShortToMask('\u{1F511}'.repeat(8))).toBe(false)
  })
})

describe('answer errors', () => {
  it('shows the cleartext refusal as it is, and a fixed text for anything else', () => {
    expect(secretAnswerErrorText(new Error(CLEARTEXT_SECRET_REFUSAL))).toBe(CLEARTEXT_SECRET_REFUSAL)
    expect(secretAnswerErrorText(new Error('sbcanary_finding6_0123456789'))).toBe(
      'Could not send the answer. Try again.',
    )
    expect(secretAnswerErrorText('x')).toBe('Could not send the answer. Try again.')
  })
})
