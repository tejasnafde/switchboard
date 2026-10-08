import { describe, expect, it, vi } from 'vitest'
import { searchMessagesOnMachines } from '../../src/renderer/services/message-search'
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
})
