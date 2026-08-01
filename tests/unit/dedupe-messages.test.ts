import { describe, it, expect } from 'vitest'
import { dedupeMessagesById } from '../../src/main/agent/dedupe-messages'
import type { ChatMessage } from '../../src/shared/types'

function msg(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'assistant', content: 'hello', timestamp: 1000, ...over }
}

describe('dedupeMessagesById', () => {
  it('keeps a single copy and counts what it removed', () => {
    // The whole point: this filter reported 0 removed for its entire life
    // because ids were synthesized per parse.
    const r = dedupeMessagesById([msg('a'), msg('a'), msg('a'), msg('b')])
    expect(r.messages.map((m) => m.id)).toEqual(['a', 'b'])
    expect(r.removed).toBe(2)
  })

  it('preserves input order and keeps the FIRST occurrence', () => {
    const first = msg('a', { content: 'first' })
    const r = dedupeMessagesById([first, msg('a', { content: 'second' }), msg('b')])
    expect(r.messages[0]).toBe(first)
    expect(r.messages.map((m) => m.content)).toEqual(['first', 'hello'])
  })

  it('reports no conflict when duplicate copies agree', () => {
    // Profile copies are byte-prefixes of each other, so this is the real case.
    const r = dedupeMessagesById([msg('a'), msg('a')])
    expect(r.conflicts).toBe(0)
  })

  it('flags a conflict when two copies of one id disagree', () => {
    // "First wins" would silently discard the other version. The loader logs
    // this rather than letting a dropped message pass unnoticed.
    expect(dedupeMessagesById([msg('a'), msg('a', { content: 'different' })]).conflicts).toBe(1)
    expect(dedupeMessagesById([msg('a'), msg('a', { timestamp: 2000 })]).conflicts).toBe(1)
    expect(dedupeMessagesById([msg('a'), msg('a', { role: 'user' })]).conflicts).toBe(1)
  })

  it('treats a differing tool-call count as a conflict', () => {
    const withTool = msg('a', { toolCalls: [{ id: 't1', name: 'Read', input: '{}' }] })
    expect(dedupeMessagesById([msg('a'), withTool]).conflicts).toBe(1)
  })

  it('does not merge distinct ids that share content', () => {
    // Two different lines of one assistant turn can carry identical text.
    const r = dedupeMessagesById([msg('a'), msg('b'), msg('c')])
    expect(r.messages).toHaveLength(3)
    expect(r.removed).toBe(0)
  })

  it('handles an empty list', () => {
    expect(dedupeMessagesById([])).toEqual({ messages: [], removed: 0, conflicts: 0 })
  })

  it('collapses a four-profile union down to one set', () => {
    // Shape of the reported bug: one session copied into four oauth dirs.
    const oneCopy = [msg('u1'), msg('u2'), msg('u3')]
    const r = dedupeMessagesById([...oneCopy, ...oneCopy, ...oneCopy, ...oneCopy])
    expect(r.messages).toHaveLength(3)
    expect(r.removed).toBe(9)
    expect(r.conflicts).toBe(0)
  })
})
