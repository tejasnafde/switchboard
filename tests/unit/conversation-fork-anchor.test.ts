import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../src/shared/types'
import { digestForkMessage, type ForkAnchor } from '../../src/shared/conversation-fork'
import {
  resolveCanonicalForkAnchor,
  type CanonicalForkMessage,
} from '../../src/main/conversations/fork-anchor'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

function message(
  id: string,
  role: ChatMessage['role'],
  content: string,
  timestamp: number,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { id, role, content, timestamp, ...extra }
}

function canonical(
  value: ChatMessage,
  options: Partial<Omit<CanonicalForkMessage, 'message'>> = {},
): CanonicalForkMessage {
  return { message: value, forkable: true, ...options }
}

function anchor(value: ChatMessage, overrides: Partial<ForkAnchor> = {}): ForkAnchor {
  return {
    messageId: value.id,
    role: value.role,
    timestamp: value.timestamp,
    contentDigest: digestForkMessage(value, sha256),
    ...overrides,
  }
}

describe('canonical conversation fork anchor', () => {
  it('resolves an exact durable id and validates the full fingerprint', () => {
    const first = message('m-1', 'user', 'Implement this', 10)
    const selected = message('m-2', 'assistant', 'I will inspect it', 20)
    const later = message('m-3', 'user', 'Continue', 30)

    expect(resolveCanonicalForkAnchor(
      [canonical(first), canonical(selected), canonical(later)],
      anchor(selected),
    )).toEqual({
      ok: true,
      prefix: [first, selected],
      resolved: {
        ...anchor(selected),
        canonicalIndex: 1,
        canonicalMessageCount: 3,
        resolution: 'exact-id',
        provider: null,
        providerSessionId: null,
        providerEventId: null,
      },
    })
  })

  it.each([
    ['role', { role: 'user' as const }],
    ['timestamp', { timestamp: 21 }],
    ['digest', { contentDigest: 'f'.repeat(64) }],
  ])('rejects an exact id carrying a stale %s', (_label, changed) => {
    const selected = message('m-2', 'assistant', 'Done', 20)
    expect(resolveCanonicalForkAnchor(
      [canonical(selected)],
      { ...anchor(selected), ...changed },
    )).toMatchObject({
      ok: false,
      conflict: { code: 'stale-anchor', candidateCount: 1 },
    })
  })

  it('allows a unique legacy fingerprint match only when the durable id is unavailable', () => {
    const selected = message('native-stable-id', 'assistant', 'Legacy imported answer', 20)
    const legacyAnchor = anchor(selected, { messageId: 'legacy-ephemeral-id' })

    expect(resolveCanonicalForkAnchor([canonical(selected)], legacyAnchor)).toMatchObject({
      ok: true,
      prefix: [selected],
      resolved: {
        messageId: 'native-stable-id',
        resolution: 'unique-legacy-fingerprint',
        canonicalIndex: 0,
      },
    })
  })

  it('rejects repeated identical messages instead of selecting the first one within a time window', () => {
    const first = message('native-1', 'user', 'ok', 1_000)
    const second = message('native-2', 'user', 'ok', 1_000)
    const legacyAnchor = anchor(second, { messageId: 'legacy-missing' })

    expect(resolveCanonicalForkAnchor(
      [canonical(first), canonical(second)],
      legacyAnchor,
    )).toEqual({
      ok: false,
      conflict: {
        code: 'ambiguous-anchor',
        message: 'The fork anchor matches more than one canonical message.',
        candidateCount: 2,
      },
    })
  })

  it('does not let a renderer-only notice or provider marker shift the selected boundary', () => {
    const source = message('m-1', 'user', 'Original prompt', 10)
    const rendererNotice = canonical(
      message('system_fork_notice_child', 'system', 'Cold fork notice', 11),
      { forkable: false },
    )
    const profileMarker = canonical(
      message('profile-marker', 'system', '[[sb:instance-rotated]] a → b', 12),
      { forkable: false },
    )
    const selected = message('m-2', 'assistant', 'Canonical answer', 20)

    const result = resolveCanonicalForkAnchor(
      [canonical(source), rendererNotice, profileMarker, canonical(selected)],
      anchor(selected),
    )
    expect(result).toMatchObject({ ok: true, resolved: { canonicalIndex: 1, canonicalMessageCount: 2 } })
    if (result.ok) expect(result.prefix.map((entry) => entry.id)).toEqual(['m-1', 'm-2'])
  })

  it('uses exact ids to distinguish a live message from a reloaded result event with the same text', () => {
    const live = message('live-runtime', 'assistant', 'Same answer', 20)
    const resultEvent = message('provider-result', 'assistant', 'Same answer', 20)

    const result = resolveCanonicalForkAnchor(
      [canonical(live), canonical(resultEvent)],
      anchor(resultEvent),
    )
    expect(result).toMatchObject({
      ok: true,
      resolved: { messageId: 'provider-result', canonicalIndex: 1, resolution: 'exact-id' },
    })
  })

  it('returns exact mixed-provider provenance without matching an older similar segment', () => {
    const claude = message('claude-message', 'assistant', 'Shared text', 20)
    const codex = message('codex-message', 'assistant', 'Shared text', 20)

    const result = resolveCanonicalForkAnchor([
      canonical(claude, {
        provenance: {
          provider: 'claude-code',
          providerSessionId: 'claude-session',
          providerEventId: 'claude-event',
        },
      }),
      canonical(codex, {
        provenance: {
          provider: 'codex',
          providerSessionId: 'codex-session',
          providerEventId: 'codex-event',
        },
      }),
    ], anchor(codex))

    expect(result).toMatchObject({
      ok: true,
      resolved: {
        provider: 'codex',
        providerSessionId: 'codex-session',
        providerEventId: 'codex-event',
      },
    })
  })

  it('accepts a second-generation persisted fork message id', () => {
    const selected = message('fork-child:message:3', 'user', 'Fork this fork', 30)
    expect(resolveCanonicalForkAnchor([canonical(selected)], anchor(selected)))
      .toMatchObject({ ok: true, resolved: { messageId: 'fork-child:message:3' } })
  })

  it('accepts an attachment-only canonical user message', () => {
    const selected = message('image-only', 'user', '', 30, {
      images: [{ url: 'data:image/png;base64,AAAA' }],
    })
    expect(resolveCanonicalForkAnchor([canonical(selected)], anchor(selected)))
      .toMatchObject({ ok: true, prefix: [selected] })
  })

  it('rejects transient activity even when its id and digest match exactly', () => {
    const activity = message('tool-running', 'assistant', '', 30, {
      toolCalls: [{ id: 'tool-1', name: 'Bash', input: 'npm test', state: 'running' }],
    })
    expect(resolveCanonicalForkAnchor(
      [canonical(activity, { forkable: false })],
      anchor(activity),
    )).toEqual({
      ok: false,
      conflict: {
        code: 'non-forkable-anchor',
        message: 'The selected item is not a durable conversation boundary.',
        candidateCount: 1,
      },
    })
  })

  it('reports a missing anchor without returning a prefix', () => {
    const selected = message('not-present', 'assistant', 'Missing', 20)
    expect(resolveCanonicalForkAnchor([], anchor(selected))).toEqual({
      ok: false,
      conflict: {
        code: 'missing-anchor',
        message: 'The fork anchor no longer exists in canonical history.',
        candidateCount: 0,
      },
    })
  })
})
