import { describe, expect, it } from 'vitest'
import {
  durableForkKey,
  projectForkSession,
} from '../../src/renderer/services/forkSession'

describe('fork renderer session projection', () => {
  it('keys a durable fork intent by stable message identity and explicit checkout policy', () => {
    expect(durableForkKey('conversation-parent-1', 'message-4', 'shared-checkout'))
      .toBe('conversation-parent-1\0message-4\0shared-checkout')
    expect(durableForkKey('conversation-parent-1', 'message-4', 'new-worktree'))
      .not.toBe(durableForkKey('conversation-parent-1', 'message-4', 'shared-checkout'))
  })

  it('keeps the parent project identity and uses authoritative worktree metadata for execution', () => {
    expect(projectForkSession({
      requestId: 'request-1',
      conversation: {
        id: 'conversation-fork-1',
        projectPath: '/projects/switchboard',
        worktreePath: '/managed/switchboard/fix',
        worktreeBranch: 'fork/fix',
        worktreeId: 'worktree-1',
        machineId: 'remote-a',
        agentType: 'claude-code',
        providerInstanceId: 'claude-tech-team',
        runtimeMode: 'sandbox',
        model: 'claude-sonnet-5',
        reasoningEffort: null,
        launchConfigName: null,
        title: 'Switchboard · fork/fix',
        parentConversationId: 'conversation-parent-1',
        anchor: {
          messageId: 'message-2', role: 'assistant', timestamp: 2,
          contentDigest: 'a'.repeat(64), canonicalIndex: 1,
          canonicalMessageCount: 2, resolution: 'exact-id',
        },
        resumeMode: 'native',
        createdAt: 1_777_000_000_000,
      },
      messages: [],
      nativeResume: { provider: 'claude', sessionId: 'claude-fork-session-1' },
      git: {
        baseSha: 'b'.repeat(40),
        path: '/managed/switchboard/fix',
        branch: 'fork/fix',
        sourceDirty: false,
      },
      warnings: [],
    })).toMatchObject({
      id: 'conversation-fork-1',
      type: 'claude-code',
      projectPath: '/projects/switchboard',
      worktreePath: '/managed/switchboard/fix',
      worktreeBranch: 'fork/fix',
      resumeSessionId: 'claude-fork-session-1',
      machineId: 'remote-a',
      instanceId: 'claude-tech-team',
      forkMetadata: { parentConversationId: 'conversation-parent-1', resumeMode: 'native' },
    })
  })
})
