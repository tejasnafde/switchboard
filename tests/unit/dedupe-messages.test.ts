import { describe, it, expect } from 'vitest'
import * as messagesModule from '../../src/main/agent/dedupe-messages'
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

describe('mergeConversationMessages', () => {
  const merge = (disk: ChatMessage[], database: ChatMessage[]): ChatMessage[] => {
    const candidate = (messagesModule as unknown as {
      mergeConversationMessages?: (diskMessages: ChatMessage[], databaseMessages: ChatMessage[]) => ChatMessage[]
    }).mergeConversationMessages
    return candidate?.(disk, database) ?? []
  }

  it('retains a SQLite-only prefix when a surviving JSONL contains only the tail', () => {
    const database = [
      msg('db-old', { role: 'user', content: 'old turn', timestamp: 100 }),
      msg('same-tail', { content: 'new turn', timestamp: 200 }),
    ]
    const disk = [msg('same-tail', {
      content: 'new turn',
      timestamp: 200,
      toolCalls: [{ id: 't', name: 'Read', input: '{}' }],
    })]

    const merged = merge(disk, database)

    expect(merged.map((message) => message.content)).toEqual(['old turn', 'new turn'])
    expect(merged[1].toolCalls).toHaveLength(1)
  })

  it('collapses legacy random DB ids against stable rollout ids by matching the same turn', () => {
    const database = [msg('msg_legacy_random', { content: 'fleet complete', timestamp: 10_500 })]
    const disk = [msg('codex_stable', { content: 'fleet complete', timestamp: 10_000 })]

    const merged = merge(disk, database)

    expect(merged).toHaveLength(1)
    expect(merged[0].id).toBe('codex_stable')
  })

  it('keeps equal content when it occurs in distinct turns far apart', () => {
    const database = [msg('db-later', { content: 'yes', timestamp: 120_000 })]
    const disk = [msg('disk-earlier', { content: 'yes', timestamp: 1_000 })]

    expect(merge(disk, database)).toHaveLength(2)
  })

  it('reconciles a large legacy transcript without scanning the full disk list per row', () => {
    const disk = Array.from({ length: 20_000 }, (_, index) =>
      msg(`disk-${index}`, { content: `turn-${index}`, timestamp: index * 100_000 }))
    const database = disk.map((message, index) => ({ ...message, id: `legacy-${index}` }))

    const startedAt = performance.now()
    const merged = merge(disk, database)

    expect(merged).toHaveLength(disk.length)
    expect(performance.now() - startedAt).toBeLessThan(1_000)
  })
})
