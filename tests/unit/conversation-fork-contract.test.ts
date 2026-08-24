import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type { ChatMessage } from '../../src/shared/types'
import {
  FORK_CONVERSATION_SCHEMA_VERSION,
  canonicalizeForkConversationIdentity,
  canonicalizeForkConversationRequest,
  digestForkMessage,
  parseForkConversationRequest,
  type ForkConversationRequest,
} from '../../src/shared/conversation-fork'

const MESSAGE_DIGEST = 'a'.repeat(64)
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

function request(): ForkConversationRequest {
  return {
    schemaVersion: FORK_CONVERSATION_SCHEMA_VERSION,
    requestId: 'fork_01J61YQ9A12BCDEF34GH567JKL',
    sourceConversationId: 'conversation-source',
    machineId: 'machine-remote-1',
    anchor: {
      messageId: 'message-anchor',
      role: 'assistant',
      timestamp: 1_787_523_600_000,
      contentDigest: MESSAGE_DIGEST,
    },
    checkout: { kind: 'shared-checkout' },
    provenance: {
      surface: 'desktop',
      requestedAt: 1_787_523_601_000,
    },
  }
}

function expectInvalid(value: unknown, path: string): void {
  const parsed = parseForkConversationRequest(value)
  expect(parsed.ok).toBe(false)
  if (parsed.ok) return
  expect(parsed.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ path }),
  ]))
}

describe('conversation fork request contract', () => {
  it('parses shared-checkout intent without accepting a renderer-authored conversation id or index', () => {
    expect(parseForkConversationRequest(request())).toEqual({
      ok: true,
      value: request(),
    })
  })

  it('parses a source-head worktree intent with a dirty-state confirmation receipt', () => {
    const value: ForkConversationRequest = {
      ...request(),
      checkout: {
        kind: 'new-worktree',
        basePolicy: 'source-head',
        dirtySourceConfirmed: {
          headSha: 'b'.repeat(40),
          statusDigest: 'c'.repeat(64),
        },
      },
      provenance: { surface: 'android', requestedAt: 1_787_523_601_000 },
    }

    expect(parseForkConversationRequest(value)).toEqual({ ok: true, value })
  })

  it.each([
    [{ ...request(), schemaVersion: 2 }, 'schemaVersion'],
    [{ ...request(), requestId: 'spaces are unsafe' }, 'requestId'],
    [{ ...request(), sourceConversationId: '' }, 'sourceConversationId'],
    [{ ...request(), machineId: 'bad machine id' }, 'machineId'],
    [{ ...request(), anchor: { ...request().anchor, messageId: '' } }, 'anchor.messageId'],
    [{ ...request(), anchor: { ...request().anchor, role: 'notice' } }, 'anchor.role'],
    [{ ...request(), anchor: { ...request().anchor, timestamp: -1 } }, 'anchor.timestamp'],
    [{ ...request(), anchor: { ...request().anchor, contentDigest: 'short' } }, 'anchor.contentDigest'],
    [{ ...request(), checkout: { kind: 'new-worktree', basePolicy: 'message-state' } }, 'checkout.basePolicy'],
    [{ ...request(), provenance: { surface: 'watch', requestedAt: 1 } }, 'provenance.surface'],
  ] as Array<[unknown, string]>)('rejects malformed request field at %s', (value, path) => {
    expectInvalid(value, path)
  })

  it('rejects confirmation receipts that are not bound to an exact HEAD and status digest', () => {
    expectInvalid({
      ...request(),
      checkout: {
        kind: 'new-worktree',
        basePolicy: 'source-head',
        dirtySourceConfirmed: { headSha: 'HEAD', statusDigest: MESSAGE_DIGEST },
      },
    }, 'checkout.dirtySourceConfirmed.headSha')
  })

  it('canonicalizes equivalent requests independently of object key order', () => {
    const first = request()
    const reordered = {
      provenance: first.provenance,
      checkout: first.checkout,
      anchor: first.anchor,
      machineId: first.machineId,
      sourceConversationId: first.sourceConversationId,
      requestId: first.requestId,
      schemaVersion: first.schemaVersion,
    }

    const parsed = parseForkConversationRequest(reordered)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(canonicalizeForkConversationRequest(first))
      .toBe(canonicalizeForkConversationRequest(parsed.value))
  })

  it('keeps audit time in the stored request but excludes it from idempotency identity', () => {
    const first = request()
    const retried = {
      ...request(),
      provenance: { ...request().provenance, requestedAt: request().provenance.requestedAt + 10_000 },
    }

    expect(canonicalizeForkConversationRequest(first))
      .not.toBe(canonicalizeForkConversationRequest(retried))
    expect(canonicalizeForkConversationIdentity(first))
      .toBe(canonicalizeForkConversationIdentity(retried))
  })

  it('changes idempotency identity when the anchor or checkout policy changes', () => {
    const first = request()
    const laterAnchor = {
      ...request(),
      anchor: { ...request().anchor, messageId: 'message-later' },
    }
    const worktree = {
      ...request(),
      checkout: { kind: 'new-worktree', basePolicy: 'source-head' } as const,
    }

    expect(canonicalizeForkConversationIdentity(first))
      .not.toBe(canonicalizeForkConversationIdentity(laterAnchor))
    expect(canonicalizeForkConversationIdentity(first))
      .not.toBe(canonicalizeForkConversationIdentity(worktree))
  })

  it('keeps dirty-source confirmation in the audit request without changing the operation identity', () => {
    const unconfirmed = {
      ...request(),
      checkout: { kind: 'new-worktree', basePolicy: 'source-head' } as const,
    }
    const confirmed = {
      ...unconfirmed,
      checkout: {
        ...unconfirmed.checkout,
        dirtySourceConfirmed: { headSha: 'b'.repeat(40), statusDigest: 'c'.repeat(64) },
      },
    }
    expect(canonicalizeForkConversationRequest(unconfirmed))
      .not.toBe(canonicalizeForkConversationRequest(confirmed))
    expect(canonicalizeForkConversationIdentity(unconfirmed))
      .toBe(canonicalizeForkConversationIdentity(confirmed))
  })
})

describe('fork message digest', () => {
  const message: ChatMessage = {
    id: 'message-source-id',
    role: 'user',
    content: 'Inspect the screenshots and [[pill:file-1]].',
    timestamp: 1_787_523_600_000,
    images: [{ url: 'data:image/png;base64,AAAA', mimeType: 'image/png', name: 'first.png' }],
    toolCalls: [{ id: 'tool-1', name: 'Read', input: '{"file_path":"README.md"}', output: 'contents' }],
    displayBody: 'Inspect the screenshots and [[pill:file-1]].',
    pillsMeta: { 'file-1': { label: 'README.md', kind: 'file' } },
    plan: { id: 'plan-1', content: '1. Inspect\n2. Repair' },
  }

  it('is stable across object-key order and ignores the source message id', () => {
    const reordered = {
      plan: message.plan,
      pillsMeta: message.pillsMeta,
      displayBody: message.displayBody,
      toolCalls: message.toolCalls,
      images: message.images,
      timestamp: message.timestamp,
      content: message.content,
      role: message.role,
      id: 'another-copy-id',
    } as ChatMessage

    expect(digestForkMessage(message, sha256)).toMatch(/^[0-9a-f]{64}$/)
    expect(digestForkMessage(reordered, sha256)).toBe(digestForkMessage(message, sha256))
  })

  it.each([
    ['content', { content: 'Changed content' }],
    ['timestamp', { timestamp: message.timestamp + 1 }],
    ['image', { images: [{ url: 'data:image/png;base64,BBBB' }] }],
    ['tool call', { toolCalls: [{ ...message.toolCalls![0], output: 'changed' }] }],
    ['display body', { displayBody: 'Changed display' }],
    ['pill metadata', { pillsMeta: { 'file-1': { label: 'src/main.ts', kind: 'file' as const } } }],
    ['plan', { plan: { ...message.plan!, content: 'Changed plan' } }],
  ])('changes when durable %s data changes', (_label, change) => {
    expect(digestForkMessage({ ...message, ...change }, sha256))
      .not.toBe(digestForkMessage(message, sha256))
  })

  it('supports an attachment-only user message', () => {
    expect(digestForkMessage({
      id: 'image-only',
      role: 'user',
      content: '',
      timestamp: 5,
      images: [{ url: 'data:image/jpeg;base64,AAAA' }],
    }, sha256)).toMatch(/^[0-9a-f]{64}$/)
  })
})
