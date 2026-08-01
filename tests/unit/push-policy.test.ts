/**
 * Which runtime events are worth waking a phone for.
 */
import { describe, it, expect } from 'vitest'
import { pushForEvent, clampBody, isExpoPushToken } from '../../src/shared/push-policy'
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
