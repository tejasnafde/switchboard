import { describe, expect, it } from 'vitest'
import { projectLoadedSearchSession } from '../../src/renderer/services/searchSessionProjection'

describe('search session projection', () => {
  it('does not request native resume for a transcript-handoff fork', () => {
    const projected = projectLoadedSearchSession({
      id: 'fork-1',
      title: 'Fork',
      projectPath: '/repo',
      agentType: 'codex',
      worktreePath: '/repo/.switchboard/worktrees/fork-1',
      worktreeBranch: 'fork/fork-1',
      providerInstanceId: 'codex-work',
      runtimeMode: 'full-access',
      model: 'gpt-5',
      reasoningEffort: 'high',
      forkMetadata: {
        parentConversationId: 'parent-1',
        parentTitle: 'Parent',
        anchor: {
          messageId: 'message-1',
          role: 'user',
          timestamp: 1,
          contentDigest: 'sha256:test',
          canonicalMessageCount: 1,
          preview: 'Fork here',
        },
        resumeMode: 'transcript-handoff',
        warnings: [],
      },
    })

    expect(projected).toMatchObject({
      id: 'fork-1',
      type: 'codex',
      projectPath: '/repo',
      worktreePath: '/repo/.switchboard/worktrees/fork-1',
      worktreeBranch: 'fork/fork-1',
      instanceId: 'codex-work',
      runtimeMode: 'full-access',
      model: 'gpt-5',
      reasoningEffort: 'high',
    })
    expect(projected.resumeSessionId).toBeUndefined()
  })

  it('retains native resume for a compatible Claude fork', () => {
    const projected = projectLoadedSearchSession({
      id: 'fork-2',
      title: 'Claude fork',
      projectPath: '/repo',
      agentType: 'claude-code',
      forkMetadata: {
        parentConversationId: 'parent-2',
        parentTitle: 'Parent',
        anchor: {
          messageId: 'message-2',
          role: 'assistant',
          timestamp: 2,
          contentDigest: 'sha256:test-2',
          canonicalMessageCount: 2,
          preview: 'Done',
        },
        resumeMode: 'native',
        warnings: [],
      },
    })

    expect(projected.resumeSessionId).toBe('fork-2')
  })
})
