/**
 * Which runtime events are worth waking a phone for.
 */
import { describe, it, expect } from 'vitest'
import {
  pushForEvent,
  clampBody,
  isExpoPushToken,
  pushTargets,
  DESKTOP_VIEWER_REF,
  VIEWING_LEASE_TTL_MS,
  VIEWING_RENEW_MS,
} from '../../src/shared/push-policy'
import type { RuntimeEvent } from '../../src/shared/provider-events'

const T = 'thread-1'

describe('pushForEvent', () => {
  it('notifies for an approval, which blocks the agent indefinitely', () => {
    const msg = pushForEvent(
      { type: 'request.opened', threadId: T, requestId: 'r', toolName: 'Write', detail: 'src/a.ts', requestType: 'tool' } as RuntimeEvent,
      { title: 'Fix the parser' },
    )
    expect(msg).toEqual({
      title: 'Fix the parser',
      body: 'Needs approval: Write - src/a.ts',
      data: { threadId: T, kind: 'approval' },
    })
  })

  it('notifies for a question', () => {
    const msg = pushForEvent(
      { type: 'question.asked', threadId: T, requestId: 'r', questions: [{ question: 'Which database?' }] } as RuntimeEvent,
      {},
    )
    expect(msg?.body).toBe('Asked: Which database?')
    expect(msg?.data.kind).toBe('question')
  })

  it('notifies when a turn finishes, with the cost when there is one', () => {
    expect(
      pushForEvent({ type: 'turn.completed', threadId: T, costUsd: 0.42 } as RuntimeEvent, {})?.body,
    ).toBe('Turn finished - $0.42')
    expect(pushForEvent({ type: 'turn.completed', threadId: T } as RuntimeEvent, {})?.body).toBe(
      'Turn finished',
    )
  })

  it('notifies on an error', () => {
    expect(pushForEvent({ type: 'error', threadId: T, message: 'spawn failed' } as RuntimeEvent, {})).toMatchObject({
      body: 'Error: spawn failed',
      data: { kind: 'error' },
    })
  })

  it('stays silent for streamed content and tool calls', () => {
    // These fire hundreds of times per turn.
    const noisy: RuntimeEvent[] = [
      { type: 'content', threadId: T, messageId: 'm', streamKind: 'assistant', text: 'hi' },
      { type: 'tool.started', threadId: T, toolId: 't', toolName: 'Bash', input: {} },
      { type: 'tool.completed', threadId: T, toolId: 't', output: 'ok' },
      { type: 'context_window', threadId: T, usedTokens: 10, maxTokens: 100 },
      { type: 'status', threadId: T, status: 'running' },
    ] as RuntimeEvent[]
    for (const e of noisy) expect(pushForEvent(e, {})).toBeNull()
  })

  it('stays silent when the phone is already on that thread', () => {
    const event = { type: 'turn.completed', threadId: T } as RuntimeEvent
    expect(pushForEvent(event, { isViewing: true })).toBeNull()
    expect(pushForEvent(event, { isViewing: false })).not.toBeNull()
  })

  it('falls back to a product title when the conversation has none', () => {
    expect(pushForEvent({ type: 'turn.completed', threadId: T } as RuntimeEvent, { title: '  ' })?.title).toBe(
      'Switchboard',
    )
  })
})

describe('clampBody', () => {
  it('collapses whitespace so a multi-line error stays one line', () => {
    expect(clampBody('a\n\n  b   c')).toBe('a b c')
  })

  it('caps length with an ellipsis', () => {
    expect(clampBody('x'.repeat(300))).toHaveLength(140)
  })

  it('returns empty for whitespace only', () => {
    expect(clampBody('   \n ')).toBe('')
  })
})

describe('isExpoPushToken', () => {
  it('accepts both spellings Expo has used', () => {
    expect(isExpoPushToken('ExponentPushToken[abc123]')).toBe(true)
    expect(isExpoPushToken('ExpoPushToken[abc123]')).toBe(true)
  })

  it('rejects anything else, so a junk value never reaches the push service', () => {
    expect(isExpoPushToken('abc123')).toBe(false)
    expect(isExpoPushToken('ExponentPushToken[]')).toBe(false)
    expect(isExpoPushToken(null)).toBe(false)
    expect(isExpoPushToken(42)).toBe(false)
  })
})

describe('pushTargets', () => {
  const PHONE_A = 'ExponentPushToken[aaa]'
  const PHONE_B = 'ExponentPushToken[bbb]'
  const devices = [{ token: PHONE_A }, { token: PHONE_B }]

  const NOW = 1_000_000
  /** A claim made just now, i.e. one the client is actively renewing. */
  const live = (threadId: string) => ({ threadId, atMs: NOW })
  /** A claim from a client that stopped renewing, e.g. a force-quit phone. */
  const expired = (threadId: string) => ({ threadId, atMs: NOW - VIEWING_LEASE_TTL_MS })

  it('notifies every device when nobody has the thread open', () => {
    expect(pushTargets(devices, T, new Map(), NOW)).toEqual(devices)
  })

  it('skips only the phone showing the thread', () => {
    const viewing = new Map([[PHONE_A, live(T)]])
    expect(pushTargets(devices, T, viewing, NOW)).toEqual([{ token: PHONE_B }])
  })

  it('still notifies a phone that has a DIFFERENT thread open', () => {
    const viewing = new Map([[PHONE_A, live('other-thread')]])
    expect(pushTargets(devices, T, viewing, NOW)).toEqual(devices)
  })

  it('silences every phone when the desktop has the thread open', () => {
    const viewing = new Map([[DESKTOP_VIEWER_REF, live(T)]])
    expect(pushTargets(devices, T, viewing, NOW)).toEqual([])
  })

  it('leaves phones alone when the desktop is on another thread', () => {
    const viewing = new Map([[DESKTOP_VIEWER_REF, live('other-thread')]])
    expect(pushTargets(devices, T, viewing, NOW)).toEqual(devices)
  })

  it('treats any non-token viewer ref as a client it cannot push to', () => {
    const viewing = new Map([['second-window', live(T)]])
    expect(pushTargets(devices, T, viewing, NOW)).toEqual([])
  })

  // A claim used to last forever. A phone that was force-quit or lost signal
  // with a thread open therefore silenced itself for that thread until the
  // backend restarted, which reads exactly like push being broken.
  it('notifies a phone again once its claim has expired', () => {
    const viewing = new Map([[PHONE_A, expired(T)]])
    expect(pushTargets(devices, T, viewing, NOW)).toEqual(devices)
  })

  it('lifts the desktop veto once its claim has expired', () => {
    const viewing = new Map([[DESKTOP_VIEWER_REF, expired(T)]])
    expect(pushTargets(devices, T, viewing, NOW)).toEqual(devices)
  })

  it('keeps honouring a claim right up to the expiry boundary', () => {
    const viewing = new Map([[PHONE_A, { threadId: T, atMs: NOW - VIEWING_LEASE_TTL_MS + 1 }]])
    expect(pushTargets(devices, T, viewing, NOW)).toEqual([{ token: PHONE_B }])
  })

  it('renews often enough that two lost renewals still hold the claim', () => {
    // Otherwise a brief network stall makes the user's own open thread buzz.
    expect(VIEWING_RENEW_MS * 2).toBeLessThan(VIEWING_LEASE_TTL_MS)
  })
})
