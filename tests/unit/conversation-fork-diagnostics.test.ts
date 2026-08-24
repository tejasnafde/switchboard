import { describe, expect, it } from 'vitest'
import { classifyLegacyFork } from '../../src/main/conversations/fork-diagnostics'

describe('legacy fork diagnostics', () => {
  it.each([
    [{ conversationId: 'c', projectPath: '/repo', parentProjectPath: '/repo', worktreePath: '/repo/w', worktreeExists: true }, 'healthy'],
    [{ conversationId: 'c', projectPath: '/repo/w', parentProjectPath: '/repo', worktreePath: '/repo/w', worktreeExists: true }, 'legacy-project-path'],
    [{ conversationId: 'c', projectPath: '/repo', parentProjectPath: '/repo', worktreePath: '/repo/w', worktreeExists: false }, 'missing-worktree'],
    [{ conversationId: null, projectPath: '/repo', parentProjectPath: null, worktreePath: '/repo/w', worktreeExists: true }, 'orphan-worktree'],
    [{ conversationId: 'c', projectPath: '/repo', parentProjectPath: '/repo', worktreePath: null, worktreeExists: false, anchorMatchCount: 2 }, 'ambiguous-anchor'],
    [{ conversationId: 'c', projectPath: '/repo', parentProjectPath: '/repo', worktreePath: null, worktreeExists: false, codexArtifactPath: '/rollout-fork-x.jsonl' }, 'unusable-native-artifact'],
  ] as const)('classifies %j as %s', (input, expected) => {
    expect(classifyLegacyFork(input)).toEqual(expect.objectContaining({ status: expected }))
  })
})
