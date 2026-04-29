/**
 * stampTurnDuration() — pure helper invoked when a `turn.completed` event
 * fires. Walks the session's messages backwards and attaches `turnDurationMs`
 * to the LAST assistant message. Tests cover:
 *   - happy path (last assistant gets stamped)
 *   - skips trailing tool/system/user messages
 *   - returns same array reference if no assistant present (no spurious work)
 *   - undefined durationMs → no-op
 */
import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '../../src/shared/types'
import { stampTurnDuration } from '../../src/renderer/services/turnDuration'

const m = (over: Partial<ChatMessage> & { id: string; role: ChatMessage['role'] }): ChatMessage => ({
  content: '',
  timestamp: 0,
  ...over,
})

describe('stampTurnDuration', () => {
  it('stamps the LAST assistant message', () => {
    const msgs: ChatMessage[] = [
      m({ id: 'u1', role: 'user', content: 'hi' }),
      m({ id: 'a1', role: 'assistant', content: 'first' }),
      m({ id: 'a2', role: 'assistant', content: 'second' }),
    ]
    const out = stampTurnDuration(msgs, 1234)
    expect(out[2].turnDurationMs).toBe(1234)
    expect(out[1].turnDurationMs).toBeUndefined()
  })

  it('walks past trailing user/system messages to find the assistant', () => {
    const msgs: ChatMessage[] = [
      m({ id: 'a1', role: 'assistant', content: 'reply' }),
      m({ id: 'u1', role: 'user', content: 'follow-up' }),
    ]
    const out = stampTurnDuration(msgs, 800)
    expect(out[0].turnDurationMs).toBe(800)
    expect(out[1].turnDurationMs).toBeUndefined()
  })

  it('returns same array reference if no assistant message present', () => {
    const msgs: ChatMessage[] = [m({ id: 'u1', role: 'user', content: 'hi' })]
    const out = stampTurnDuration(msgs, 500)
    expect(out).toBe(msgs)
  })

  it('returns same array reference if durationMs is undefined', () => {
    const msgs: ChatMessage[] = [m({ id: 'a1', role: 'assistant', content: 'x' })]
    const out = stampTurnDuration(msgs, undefined)
    expect(out).toBe(msgs)
  })

  it('does not mutate input array or message objects', () => {
    const msgs: ChatMessage[] = [m({ id: 'a1', role: 'assistant', content: 'x' })]
    const before = JSON.parse(JSON.stringify(msgs))
    stampTurnDuration(msgs, 100)
    expect(msgs).toEqual(before)
  })
})
