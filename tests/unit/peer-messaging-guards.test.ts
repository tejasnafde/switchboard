import { describe, it, expect } from 'vitest'
import {
  PeerAgentSendGuard,
  PeerMessageGuard,
  nextHopDepth,
  peerMessageId,
  peerSentMarkerPrefix,
  wrapPeerMessage,
  PEER_AGENT_SENT_MARKER_PREFIX,
  PEER_AGENT_SEND_BUDGET,
  PEER_AGENT_SEND_WINDOW_MS,
  PEER_MESSAGE_MAX_BYTES,
  PEER_MESSAGE_MAX_HOP_DEPTH,
  PEER_MESSAGE_RATE_LIMIT,
  PEER_MESSAGE_RATE_WINDOW_MS,
  PEER_MESSAGE_DEDUPE_WINDOW_MS,
  PEER_SENT_MARKER_PREFIX,
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

describe('nextHopDepth', () => {
  // The human authored the text, so the recipient is not one hop from a human.
  it('resets to zero for a user-initiated delivery, whatever the sender depth', () => {
    expect(nextHopDepth(0, 'user')).toBe(0)
    expect(nextHopDepth(3, 'user')).toBe(0)
  })

  it('counts one more hop for an agent-initiated delivery', () => {
    expect(nextHopDepth(0, 'agent')).toBe(1)
    expect(nextHopDepth(1, 'agent')).toBe(2)
  })
})

describe('PeerAgentSendGuard hop depth', () => {
  it('lets a turn the user started originate a send', () => {
    const guard = new PeerAgentSendGuard()
    expect(guard.check({ fromThreadId: 'a', senderDepth: 0 }, 1_000).ok).toBe(true)
  })

  // The boundary: depth 1 is already the deepest a peer message may create, so
  // a send from there would make depth 2 and start A -> B -> A.
  it('refuses a send from a turn that a peer message started', () => {
    const guard = new PeerAgentSendGuard()
    const out = guard.check({ fromThreadId: 'a', senderDepth: PEER_MESSAGE_MAX_HOP_DEPTH }, 1_000)
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toBe('hop-depth')
    expect(out.ok === false && out.message).toMatch(/user/i)
  })

  it('refuses every depth past the limit', () => {
    const guard = new PeerAgentSendGuard()
    expect(guard.check({ fromThreadId: 'a', senderDepth: 2 }, 1_000).ok).toBe(false)
    expect(guard.check({ fromThreadId: 'a', senderDepth: 9 }, 1_000).ok).toBe(false)
  })

  // A hop-depth refusal is not the sender's fault in the budget sense, and
  // charging it would let a blocked chain eat the budget it can never spend.
  it('does not charge a hop-depth refusal against the budget', () => {
    const guard = new PeerAgentSendGuard()
    for (let i = 0; i < PEER_AGENT_SEND_BUDGET + 2; i++) {
      guard.check({ fromThreadId: 'a', senderDepth: 1 }, 1_000 + i)
    }
    expect(guard.check({ fromThreadId: 'a', senderDepth: 0 }, 2_000).ok).toBe(true)
  })
})

describe('PeerAgentSendGuard budget', () => {
  const spend =(guard: PeerAgentSendGuard, count: number, from = 'a') => {
    for (let i = 0; i < count; i++) {
      expect(guard.check({ fromThreadId: from, senderDepth: 0 }, 1_000 + i).ok).toBe(true)
    }
  }

  it('accepts exactly the budget and refuses the next one', () => {
    const guard = new PeerAgentSendGuard()
    spend(guard, PEER_AGENT_SEND_BUDGET)
    const over = guard.check({ fromThreadId: 'a', senderDepth: 0 }, 1_000 + PEER_AGENT_SEND_BUDGET)
    expect(over.ok).toBe(false)
    expect(over.ok === false && over.reason).toBe('budget')
    expect(over.ok === false && over.message).toMatch(/sessions/i)
  })

  // The point of this guard: the per-pair limit cannot be multiplied by
  // opening more targets, because the budget never looks at the target.
  it('counts every target against one sending-session budget', () => {
    const guard = new PeerAgentSendGuard()
    spend(guard, PEER_AGENT_SEND_BUDGET)
    expect(guard.check({ fromThreadId: 'a', senderDepth: 0 }, 1_500).ok).toBe(false)
  })

  it('gives each sending session its own budget', () => {
    const guard = new PeerAgentSendGuard()
    spend(guard, PEER_AGENT_SEND_BUDGET)
    expect(guard.check({ fromThreadId: 'b', senderDepth: 0 }, 1_500).ok).toBe(true)
  })

  it('lets the window slide', () => {
    const guard = new PeerAgentSendGuard()
    spend(guard, PEER_AGENT_SEND_BUDGET)
    expect(guard.check({ fromThreadId: 'a', senderDepth: 0 }, 1_500).ok).toBe(false)
    // Only the oldest send ages out, so exactly one slot reopens.
    const afterOldest = 1_000 + PEER_AGENT_SEND_WINDOW_MS
    expect(guard.check({ fromThreadId: 'a', senderDepth: 0 }, afterOldest).ok).toBe(true)
    expect(guard.check({ fromThreadId: 'a', senderDepth: 0 }, afterOldest).ok).toBe(false)
  })

  // Delivery can still fail after the guard accepts. Holding the slot would
  // charge the sender for a message that never arrived.
  it('release frees one slot', () => {
    const guard = new PeerAgentSendGuard()
    spend(guard, PEER_AGENT_SEND_BUDGET)
    guard.release('a')
    expect(guard.check({ fromThreadId: 'a', senderDepth: 0 }, 1_500).ok).toBe(true)
  })

  it('release on an unknown sender is harmless', () => {
    const guard = new PeerAgentSendGuard()
    guard.release('never-sent')
    expect(guard.check({ fromThreadId: 'never-sent', senderDepth: 0 }, 1_000).ok).toBe(true)
  })
})

describe('peerSentMarkerPrefix', () => {
  it('marks the two initiators apart', () => {
    expect(peerSentMarkerPrefix('user')).toBe(PEER_SENT_MARKER_PREFIX)
    expect(peerSentMarkerPrefix('agent')).toBe(PEER_AGENT_SENT_MARKER_PREFIX)
  })

  // parseRotationMarker dispatches on startsWith, so one prefix must not be a
  // prefix of the other or every agent send would render as a user send.
  it('keeps neither prefix a prefix of the other', () => {
    expect(PEER_AGENT_SENT_MARKER_PREFIX.startsWith(PEER_SENT_MARKER_PREFIX)).toBe(false)
    expect(PEER_SENT_MARKER_PREFIX.startsWith(PEER_AGENT_SENT_MARKER_PREFIX)).toBe(false)
  })
})
