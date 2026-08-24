import { describe, expect, it } from 'vitest'
import {
  durableForkKey,
  projectForkSession,
  shouldClearForkWorktreeProgress,
} from '../../src/renderer/services/forkSession'

describe('fork renderer session projection', () => {
  it('clears fork progress after either retained or removed cleanup completes', () => {
    expect(shouldClearForkWorktreeProgress({
      status: 'cleanup_required',
      cleanupDisposition: 'retained',
    })).toBe(true)
    expect(shouldClearForkWorktreeProgress({
      status: 'rolled_back',
      cleanupDisposition: 'removed',
    })).toBe(true)
    expect(shouldClearForkWorktreeProgress({
      status: 'cleanup_required',
    })).toBe(false)
  })

  it('keys a durable fork intent by stable transcript position instead of regenerated message IDs', () => {
    expect(durableForkKey('conversation-parent-1', 4)).toBe('conversation-parent-1\0' + '4')
    expect(durableForkKey('conversation-parent-1', 4)).toBe(durableForkKey('conversation-parent-1', 4))
    expect(durableForkKey('conversation-parent-1', 5)).not.toBe(durableForkKey('conversation-parent-1', 4))
  })

  it('keeps the parent project identity and uses authoritative worktree metadata for execution', () => {
    expect(projectForkSession({
      conversation: {
        id: 'conversation-fork-1',
        projectPath: '/projects/switchboard',
        agentType: 'claude-code',
        title: 'Switchboard · fork/fix',
        parentConversationId: 'conversation-parent-1',
        forkedAtMessageId: 'message-2',
        createdAt: 1_777_000_000_000,
      },
      resumeHint: 'claude-fork-session-1',
      worktree: {
        path: '/managed/switchboard/fix',
        branch: 'fork/fix',
      },
    })).toMatchObject({
      id: 'conversation-fork-1',
      type: 'claude-code',
      projectPath: '/projects/switchboard',
      worktreePath: '/managed/switchboard/fix',
      worktreeBranch: 'fork/fix',
      resumeSessionId: 'claude-fork-session-1',
    })
  })
})
