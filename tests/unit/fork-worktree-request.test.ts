import { describe, expect, it } from 'vitest'
import { buildForkWorktreeRequest } from '../../src/main/conversations/fork-worktree-owner'

describe('buildForkWorktreeRequest', () => {
  it('keeps the parent project identity while branching from the source worktree revision', () => {
    const result = buildForkWorktreeRequest({
      source: {
        id: 'parent-1',
        projectPath: '/repo',
        worktreeBranch: 'fork/earlier-fork',
      },
      selectedBody: 'Fix the retry race',
      input: {
        sourceConversationId: 'parent-1',
        upToIndex: 4,
        forkedAtMessageId: 'message-5',
        creationId: 'creation-stable',
        conversationId: 'conversation-stable',
        machineId: 'machine-1',
      },
      requestedAt: 123,
    })

    expect(result).toMatchObject({
      creationId: 'creation-stable',
      repository: { projectPath: '/repo', machineId: 'machine-1' },
      checkout: {
        baseRef: 'fork/earlier-fork',
        branch: { namespace: 'fork', seed: 'fix-the-retry-race' },
      },
      owner: {
        kind: 'fork',
        conversationId: 'conversation-stable',
        parentConversationId: 'parent-1',
        upToIndex: 4,
      },
    })
  })
})
