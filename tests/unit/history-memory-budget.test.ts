/** The renderer's per-chat memory budget: what a trim drops, and what it never drops. */
import { describe, expect, it } from 'vitest'
import {
  estimateMessageBytes,
  planHistoryTrim,
  type HistoryMemoryBudget,
} from '../../src/renderer/services/history-memory-budget'
import type { ChatMessage } from '../../src/shared/types'

/** Alternating user and assistant rows, so every even index starts a turn. */
function chat(count: number, content = 'x'): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content,
    timestamp: i,
  })) as ChatMessage[]
}

const budget: HistoryMemoryBudget = {
  maxMessages: 100,
  maxBytes: 1_000_000,
  targetShare: 0.5,
  minKept: 10,
  minKeptTurns: 1,
}

describe('estimateMessageBytes', () => {
  it('counts text, tool calls, image data URLs and diffs', () => {
    const base = estimateMessageBytes({ id: 'a', role: 'assistant', content: '', timestamp: 0 })
    const full = estimateMessageBytes({
      id: 'a',
      role: 'assistant',
      content: 'abcd',
      timestamp: 0,
      toolCalls: [{ id: 't', name: 'Bash', input: 'ls', output: 'out' }],
      images: [{ url: 'data:image/png;base64,AAAA' }],
      fileDiff: {
        fileEditId: 'f',
        repoRoot: '/r',
        relPath: 'a.ts',
        changeKind: 'modify',
        oldContent: 'old',
        newContent: 'new',
        status: 'accepted',
      },
    })
    const chars = 4 + 'Bash'.length + 2 + 3 + 'data:image/png;base64,AAAA'.length + 6
    expect(full - base).toBe(chars * 2)
  })
})

describe('planHistoryTrim', () => {
  it('drops nothing inside the budget', () => {
    expect(planHistoryTrim(chat(100), { budget })).toBe(0)
  })

  it('drops whole turns down to the target share of the count budget', () => {
    const messages = chat(120)
    const drop = planHistoryTrim(messages, { budget })
    expect(drop).toBe(70)
    expect(messages[drop].role).toBe('user')
  })

  it('trims by bytes when few rows are large', () => {
    const messages = chat(40, 'y'.repeat(15_000))
    const drop = planHistoryTrim(messages, { budget })
    expect(drop).toBeGreaterThan(0)
    expect(drop % 2).toBe(0)
    const kept = messages.slice(drop).reduce((sum, m) => sum + estimateMessageBytes(m), 0)
    expect(kept).toBeLessThanOrEqual(budget.maxBytes * budget.targetShare)
  })

  it('keeps the shown rows and everything after them', () => {
    expect(planHistoryTrim(chat(120), { protectFrom: 30, budget })).toBe(30)
    expect(planHistoryTrim(chat(120), { protectFrom: 31, budget })).toBe(30)
    expect(planHistoryTrim(chat(120), { protectFrom: 0, budget })).toBe(0)
  })

  it('keeps the last turn while it streams', () => {
    const messages = chat(120)
    const oneTurn = [messages[0], ...messages.slice(1).map((m) => ({ ...m, role: 'assistant' as const }))]
    expect(planHistoryTrim(oneTurn, { budget })).toBe(0)
  })

  it('stops before a row that waits on the user or the backend', () => {
    const messages = chat(120)
    messages[20] = { ...messages[20], deliveryState: 'pending' }
    expect(planHistoryTrim(messages, { budget })).toBe(20)
    const asking = chat(120)
    asking[41] = { ...asking[41], approval: { toolName: 'Bash', detail: 'ls', status: 'pending' } }
    expect(planHistoryTrim(asking, { budget })).toBe(40)
  })

  it('keeps at least minKept rows whatever their size', () => {
    const messages = chat(20, 'z'.repeat(200_000))
    const drop = planHistoryTrim(messages, { budget })
    expect(messages.length - drop).toBe(budget.minKept)
  })

  it('keeps the last minKeptTurns turns, so the list at its bottom does not prefetch them back', () => {
    const messages = chat(120)
    expect(planHistoryTrim(messages, { budget: { ...budget, minKeptTurns: 30 } })).toBe(60)
    expect(planHistoryTrim(chat(20), { budget: { ...budget, maxMessages: 5, minKept: 0, minKeptTurns: 11 } })).toBe(0)
  })

  it('never makes a row appended live the first one', () => {
    const messages = chat(120)
    expect(planHistoryTrim(messages, { liveIds: new Set(['m70']), budget })).toBe(72)
  })

  it('never makes a subagent row the first one', () => {
    const messages = chat(120)
    messages[70] = { ...messages[70], parentToolCallId: 'agent-call' }
    expect(planHistoryTrim(messages, { budget })).toBe(72)
  })
})
