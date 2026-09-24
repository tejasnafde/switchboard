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

  it('enriches a semantic disk match with images and display metadata from SQLite', () => {
    const disk = [msg('codex_stable', {
      role: 'user',
      content: 'look at this',
      timestamp: 10_000,
      images: [{ url: 'data:image/png;base64,AAA' }],
    })]
    const database = [msg('msg_legacy_random', {
      role: 'user',
      content: 'look at this',
      timestamp: 10_500,
      images: [
        { url: 'data:image/png;base64,AAA', mimeType: 'image/png', name: 'screen.png' },
        { url: 'data:image/jpeg;base64,BBB', mimeType: 'image/jpeg' },
      ],
      displayBody: 'look at [[pill:screen]]',
      pillsMeta: { screen: { label: 'screen.png', kind: 'file' } },
    })]

    const merged = merge(disk, database)

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 'codex_stable',
      displayBody: 'look at [[pill:screen]]',
      pillsMeta: { screen: { label: 'screen.png', kind: 'file' } },
      images: [
        { url: 'data:image/png;base64,AAA', mimeType: 'image/png', name: 'screen.png' },
        { url: 'data:image/jpeg;base64,BBB', mimeType: 'image/jpeg' },
      ],
    })
  })

  it('enriches an exact-id disk match instead of discarding SQLite images', () => {
    const disk = [msg('same', { role: 'user', content: '', images: undefined })]
    const database = [msg('same', {
      role: 'user',
      content: '',
      images: [{ url: 'data:image/webp;base64,CCC', mimeType: 'image/webp' }],
    })]

    expect(merge(disk, database)).toEqual([
      expect.objectContaining({
        id: 'same',
        images: [{ url: 'data:image/webp;base64,CCC', mimeType: 'image/webp' }],
      }),
    ])
  })

  it('keeps equal content when it occurs in distinct turns far apart', () => {
    const database = [msg('db-later', { content: 'yes', timestamp: 120_000 })]
    const disk = [msg('disk-earlier', { content: 'yes', timestamp: 1_000 })]

    expect(merge(disk, database)).toHaveLength(2)
  })

  // Timestamps from a real Claude turn (2026-09). The registry mirrored every
  // assistant message of the turn at turn end, so the interim texts carried a
  // SQLite timestamp 94s and 191s after their JSONL copy. They missed the
  // window, came back as SQLite-only rows, and sorted below the final answer.
  it('matches mirror rows stamped at turn end to their JSONL copies in the same turn', () => {
    const disk = [
      msg('u', { role: 'user', content: 'finish it', timestamp: 1_790_195_600_000 }),
      msg('d1', { content: 'The whole flow passes.', timestamp: 1_790_195_728_763 }),
      msg('d2', { content: 'Committed on the branch.', timestamp: 1_790_195_826_233 }),
      msg('d3', { content: 'The web app now runs.', timestamp: 1_790_195_919_936 }),
    ]
    const database = [
      msg('turn_1', { role: 'user', content: 'finish it', timestamp: 1_790_195_600_010 }),
      msg('msg_a', { content: 'The whole flow passes.', timestamp: 1_790_195_920_122 }),
      msg('msg_b', { content: 'Committed on the branch.', timestamp: 1_790_195_920_122 }),
      msg('msg_c', { content: 'The web app now runs.', timestamp: 1_790_195_920_122 }),
    ]

    expect(merge(disk, database).map((m) => m.id)).toEqual(['u', 'd1', 'd2', 'd3'])
  })

  it('does not match a mirror row to an equal message from an earlier turn', () => {
    const disk = [
      msg('d1', { content: 'Done.', timestamp: 1_000 }),
      msg('u2', { role: 'user', content: 'again', timestamp: 200_000 }),
    ]
    const database = [msg('msg_x', { content: 'Done.', timestamp: 400_000 })]

    expect(merge(disk, database).map((m) => m.id)).toEqual(['d1', 'u2', 'msg_x'])
  })

  it('ends a turn at a SQLite user row when the transcript lacks that user line', () => {
    const disk = [
      msg('u1', { role: 'user', content: 'first', timestamp: 0 }),
      msg('d1', { content: 'Done.', timestamp: 1_000 }),
    ]
    const database = [
      msg('turn_2', { role: 'user', content: 'second', timestamp: 300_000 }),
      msg('msg_b', { content: 'Done.', timestamp: 400_000 }),
    ]

    expect(merge(disk, database).map((m) => m.id)).toEqual(['u1', 'd1', 'turn_2', 'msg_b'])
  })

  it('keeps a new turn\'s reply when the previous turn gave the same reply under 60s earlier', () => {
    const disk = [
      msg('u1', { role: 'user', content: 'first', timestamp: 0 }),
      msg('d1', { content: 'ok', timestamp: 1_000 }),
      msg('u2', { role: 'user', content: 'second', timestamp: 10_000 }),
    ]
    const database = [msg('msg_b', { content: 'ok', timestamp: 20_000 })]

    expect(merge(disk, database).map((m) => m.id)).toEqual(['u1', 'd1', 'u2', 'msg_b'])
  })

  it('keeps a new turn\'s reply when the previous turn\'s equal reply ended just before it', () => {
    const disk = [
      msg('u1', { role: 'user', content: 'first', timestamp: 0 }),
      msg('d1', { content: 'ok', timestamp: 9_000 }),
      msg('u2', { role: 'user', content: 'second', timestamp: 10_000 }),
    ]
    const database = [msg('msg_b', { content: 'ok', timestamp: 12_000 })]

    expect(merge(disk, database).map((m) => m.id)).toEqual(['u1', 'd1', 'u2', 'msg_b'])
  })

  it('keeps a turn\'s reply when only the next turn\'s equal reply is on disk, under 60s later', () => {
    const disk = [
      msg('u1', { role: 'user', content: 'first', timestamp: 0 }),
      msg('u2', { role: 'user', content: 'second', timestamp: 10_000 }),
      msg('d2', { content: 'ok', timestamp: 20_000 }),
    ]
    const database = [msg('msg_a', { content: 'ok', timestamp: 1_000 })]

    expect(merge(disk, database).map((m) => m.id)).toEqual(['u1', 'msg_a', 'u2', 'd2'])
  })

  it('keeps equal user messages with another user message between them as separate turns', () => {
    const disk = [
      msg('u1', { role: 'user', content: 'go', timestamp: 0 }),
      msg('d1', { content: 'ok', timestamp: 500 }),
      msg('u2', { role: 'user', content: 'stop', timestamp: 1_000 }),
      msg('u3', { role: 'user', content: 'go', timestamp: 2_000 }),
    ]
    const database = [msg('msg_c', { content: 'ok', timestamp: 2_500 })]

    expect(merge(disk, database).map((m) => m.id)).toEqual(['u1', 'd1', 'u2', 'u3', 'msg_c'])
  })

  it('still matches a reply to its own turn when the two user copies are stamped apart', () => {
    const disk = [
      msg('u1', { role: 'user', content: 'go', timestamp: 10_000 }),
      msg('d1', { content: 'ok', timestamp: 10_500 }),
    ]
    const database = [
      msg('turn_1', { role: 'user', content: 'go', timestamp: 11_000 }),
      msg('msg_a', { content: 'ok', timestamp: 12_000 }),
    ]

    expect(merge(disk, database).map((m) => m.id)).toEqual(['u1', 'd1'])
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
