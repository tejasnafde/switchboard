import { describe, expect, it, vi } from 'vitest'
import { searchHitReadyId, searchHitShownId, searchMessagesOnMachines } from '../../src/renderer/services/message-search'
import type { MessageSearchResult } from '../../src/shared/message-search'

vi.mock('../../src/renderer/logger', () => ({
  createRendererLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

function hit(messageId: string, rank: number, timestamp: number): MessageSearchResult {
  return {
    messageId, conversationId: `c-${messageId}`, role: 'assistant', content: '', snippet: '',
    conversationTitle: '', projectPath: '/repo', agentType: 'claude-code', worktreePath: null, worktreeBranch: null,
    rank, timestamp, phraseMatch: true,
  }
}

describe('searchMessagesOnMachines', () => {
  it('merges every machine in one order and tags each hit with its machine', async () => {
    const results = await searchMessagesOnMachines('q', [
      { machineId: 'local', search: async () => [hit('old', -3, 1)] },
      { machineId: 'vm', search: async () => [hit('new', -3, 2)] },
    ])
    expect(results.map((r) => [r.machineId, r.messageId])).toEqual([['vm', 'new'], ['local', 'old']])
  })

  it('keeps the other machines when one fails or answers nothing', async () => {
    const results = await searchMessagesOnMachines('q', [
      { machineId: 'local', search: async () => [hit('a', -1, 1)] },
      { machineId: 'down', search: async () => { throw new Error('offline') } },
      { machineId: 'old', search: async () => null },
    ])
    expect(results.map((r) => r.messageId)).toEqual(['a'])
  })

  it('keeps the other machines when one never answers, instead of waiting forever', async () => {
    vi.useFakeTimers()
    try {
      const resultsPromise = searchMessagesOnMachines('q', [
        { machineId: 'local', search: async () => [hit('a', -1, 1)] },
        { machineId: 'stuck', search: () => new Promise(() => {}) },
      ])
      // Let the fast machine's hit land, then run the stuck one past its deadline.
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(30_000)
      const results = await resultsPromise
      expect(results.map((r) => r.messageId)).toEqual(['a'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('searchHitShownId', () => {
  it('names the hit chat only when that chat is the one focused', () => {
    expect(searchHitShownId({ conversationId: 'c1' }, 'c1')).toBe('c1')
    expect(searchHitShownId({ conversationId: 'c1' }, 'other')).toBeNull()
    expect(searchHitShownId({ conversationId: 'c1' }, null)).toBeNull()
  })
})

describe('searchHitReadyId', () => {
  const baseHit = { conversationId: 'c1', messageId: 'm-old' }

  it('reports ready at once when the hit message is already loaded', async () => {
    const ensureFullHistory = vi.fn(async () => true)
    const id = await searchHitReadyId(baseHit, {
      focusedId: () => 'c1',
      sessionMessages: () => [{ id: 'm-old' }, { id: 'm-new' }],
      ensureFullHistory,
    })
    expect(id).toBe('c1')
    expect(ensureFullHistory).not.toHaveBeenCalled()
  })

  it('loads the full history before reporting ready when the hit predates the loaded window', async () => {
    // Only the newest window is loaded; the hit's message is older than it.
    const messages = [{ id: 'm-new' }]
    const ensureFullHistory = vi.fn(async () => {
      messages.unshift({ id: 'm-old' })
      return true
    })
    const id = await searchHitReadyId(baseHit, {
      focusedId: () => 'c1',
      sessionMessages: () => messages,
      ensureFullHistory,
    })
    expect(ensureFullHistory).toHaveBeenCalledWith('c1')
    expect(id).toBe('c1')
    expect(messages.map((m) => m.id)).toContain('m-old')
  })

  it('returns null up front when the hit chat never became the focused one', async () => {
    const ensureFullHistory = vi.fn(async () => true)
    const id = await searchHitReadyId(baseHit, {
      focusedId: () => 'other',
      sessionMessages: () => [],
      ensureFullHistory,
    })
    expect(id).toBeNull()
    expect(ensureFullHistory).not.toHaveBeenCalled()
  })

  it('returns null when another hit moves focus away while history loads', async () => {
    let focused = 'c1'
    const ensureFullHistory = vi.fn(async () => {
      focused = 'c2' // the user opened a different hit meanwhile
      return true
    })
    const id = await searchHitReadyId(baseHit, {
      focusedId: () => focused,
      sessionMessages: () => [{ id: 'm-new' }],
      ensureFullHistory,
    })
    expect(id).toBeNull()
  })

  it('still reports ready when the full history load cannot find the message, keeping the in-pane fallback working', async () => {
    const ensureFullHistory = vi.fn(async () => false)
    const id = await searchHitReadyId(baseHit, {
      focusedId: () => 'c1',
      sessionMessages: () => [{ id: 'm-new' }],
      ensureFullHistory,
    })
    expect(id).toBe('c1')
  })
})
