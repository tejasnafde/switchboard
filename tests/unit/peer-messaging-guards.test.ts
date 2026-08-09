import { describe, it, expect } from 'vitest'
import {
  PeerMessageGuard,
  peerMessageId,
  wrapPeerMessage,
  PEER_MESSAGE_MAX_BYTES,
  PEER_MESSAGE_RATE_LIMIT,
  PEER_MESSAGE_RATE_WINDOW_MS,
  PEER_MESSAGE_DEDUPE_WINDOW_MS,
} from '../../src/shared/peer-messaging'

const base = { fromThreadId: 'a', targetThreadId: 'b', text: 'ship it' }

describe('peerMessageId', () => {
  it('is content-addressed: same triple, same id', () => {
    expect(peerMessageId(base)).toBe(peerMessageId({ ...base }))
  })

  it('changes when any part of the triple changes', () => {
    const id = peerMessageId(base)
    expect(peerMessageId({ ...base, text: 'ship it ' })).not.toBe(id)
    expect(peerMessageId({ ...base, targetThreadId: 'c' })).not.toBe(id)
    expect(peerMessageId({ ...base, fromThreadId: 'z' })).not.toBe(id)
  })

  // The separator is what stops ('ab','c') and ('a','bc') hashing the same.
  it('does not collide across a field boundary', () => {
    expect(peerMessageId({ fromThreadId: 'ab', targetThreadId: 'c', text: 't' }))
      .not.toBe(peerMessageId({ fromThreadId: 'a', targetThreadId: 'bc', text: 't' }))
  })

  it('has a stable prefixed shape', () => {
    expect(peerMessageId(base)).toMatch(/^pm_[0-9a-f]{16}$/)
  })
})

describe('wrapPeerMessage', () => {
  it('names the sending session and states the message is not from the user', () => {
    const wire = wrapPeerMessage('API refactor', 'the migration landed')
    expect(wire).toContain('[Message from your user\'s other session "API refactor"]')
    expect(wire).toContain('the migration landed')
    expect(wire).toContain('another agent session')
    expect(wire).toContain('cannot approve or deny')
  })
})

describe('PeerMessageGuard', () => {
  it('accepts a first message and reports its id', () => {
    const guard = new PeerMessageGuard()
    const out = guard.check(base, 1_000)
    expect(out.ok).toBe(true)
    expect(out.ok && out.id).toBe(peerMessageId(base))
  })

  it('refuses a body over the byte cap', () => {
    const guard = new PeerMessageGuard()
    const out = guard.check({ ...base, text: 'x'.repeat(PEER_MESSAGE_MAX_BYTES + 1) }, 1_000)
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toBe('too-large')
  })

  // Cap is BYTES, not characters - a multi-byte body must not slip past it.
  it('measures the cap in utf-8 bytes', () => {
    const guard = new PeerMessageGuard()
    const text = 'é'.repeat(PEER_MESSAGE_MAX_BYTES / 2 + 1) // 2 bytes each
    expect(text.length).toBeLessThan(PEER_MESSAGE_MAX_BYTES)
    expect(guard.check({ ...base, text }, 1_000).ok).toBe(false)
  })

  it('accepts a body exactly at the cap', () => {
    const guard = new PeerMessageGuard()
    expect(guard.check({ ...base, text: 'x'.repeat(PEER_MESSAGE_MAX_BYTES) }, 1_000).ok).toBe(true)
  })

  it('drops an identical id inside the dedupe window', () => {
    const guard = new PeerMessageGuard()
    expect(guard.check(base, 1_000).ok).toBe(true)
    const again = guard.check(base, 1_000 + PEER_MESSAGE_DEDUPE_WINDOW_MS - 1)
    expect(again.ok).toBe(false)
    expect(again.ok === false && again.reason).toBe('duplicate')
  })

  it('allows the same text again once the dedupe window has passed', () => {
    const guard = new PeerMessageGuard()
    guard.check(base, 1_000)
    expect(guard.check(base, 1_000 + PEER_MESSAGE_DEDUPE_WINDOW_MS + 1).ok).toBe(true)
  })

  it('rate-limits per (from, target) pair', () => {
    const guard = new PeerMessageGuard()
    for (let i = 0; i < PEER_MESSAGE_RATE_LIMIT; i++) {
      expect(guard.check({ ...base, text: `msg ${i}` }, 1_000 + i).ok).toBe(true)
    }
    const over = guard.check({ ...base, text: 'one too many' }, 1_000 + PEER_MESSAGE_RATE_LIMIT)
    expect(over.ok).toBe(false)
    expect(over.ok === false && over.reason).toBe('rate-limited')
  })

  it('counts the rate limit per pair, not globally', () => {
    const guard = new PeerMessageGuard()
    for (let i = 0; i < PEER_MESSAGE_RATE_LIMIT; i++) {
      guard.check({ ...base, text: `msg ${i}` }, 1_000 + i)
    }
    expect(guard.check({ fromThreadId: 'a', targetThreadId: 'other', text: 'hi' }, 1_100).ok).toBe(true)
    expect(guard.check({ fromThreadId: 'other', targetThreadId: 'b', text: 'hi' }, 1_100).ok).toBe(true)
  })

  it('lets the rate window slide', () => {
    const guard = new PeerMessageGuard()
    for (let i = 0; i < PEER_MESSAGE_RATE_LIMIT; i++) {
      guard.check({ ...base, text: `msg ${i}` }, 1_000 + i)
    }
    expect(guard.check({ ...base, text: 'blocked' }, 1_500).ok).toBe(false)
    // The oldest send ages out of the window, so exactly one slot reopens.
    const afterOldest = 1_000 + PEER_MESSAGE_RATE_WINDOW_MS
    expect(guard.check({ ...base, text: 'allowed' }, afterOldest).ok).toBe(true)
    expect(guard.check({ ...base, text: 'blocked again' }, afterOldest).ok).toBe(false)
  })

  // A refused send must not consume a slot, or one oversized paste locks the
  // pair out for a minute.
  it('does not charge a refused send against the rate limit', () => {
    const guard = new PeerMessageGuard()
    guard.check({ ...base, text: 'x'.repeat(PEER_MESSAGE_MAX_BYTES + 1) }, 1_000)
    for (let i = 0; i < PEER_MESSAGE_RATE_LIMIT; i++) {
      expect(guard.check({ ...base, text: `msg ${i}` }, 1_001 + i).ok).toBe(true)
    }
  })

  it('explains every refusal in a sentence the chat can show', () => {
    const guard = new PeerMessageGuard()
    guard.check(base, 1_000)
    const dup = guard.check(base, 1_100)
    expect(dup.ok === false && dup.message.length).toBeGreaterThan(0)
  })
})
