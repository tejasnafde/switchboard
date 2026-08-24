import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationSnapshot } from '../../src/shared/worktree-creation'
import { WorktreeCreationProgress } from '../../src/renderer/components/worktree/WorktreeCreationProgress'

function snapshot(overrides: Partial<WorktreeCreationSnapshot> = {}): WorktreeCreationSnapshot {
  return {
    creationId: 'creation-progress-1',
    revision: 3,
    phase: 'configuring',
    status: 'pending',
    worktreeId: 'worktree-progress-1',
    projectPath: '/repo',
    worktreePath: '/repo/.switchboard/worktrees/progress',
    branch: 'sb/progress',
    baseRef: 'HEAD',
    owner: {
      kind: 'conversation',
      conversationId: 'conversation-progress-1',
      agentType: 'claude-code',
    },
    purpose: 'new-chat',
    provenance: { surface: 'desktop', machineId: 'local', requestedAt: 1 },
    warnings: [],
    recoveryActions: [],
    updatedAt: 3,
    ...overrides,
  }
}

describe('WorktreeCreationProgress', () => {
  it('uses honest phase copy without fake percentage progress', () => {
    const markup = renderToStaticMarkup(createElement(WorktreeCreationProgress, {
      snapshot: snapshot(),
    }))

    expect(markup).toContain('Configuring sparse checkout')
    expect(markup).toContain('creation-progress-1')
    expect(markup).not.toMatch(/\d+%/)
    expect(markup).not.toContain('progressbar')
  })

  it('explains retained mutable state and renders only advertised recovery actions', () => {
    const onAction = vi.fn()
    const markup = renderToStaticMarkup(createElement(WorktreeCreationProgress, {
      snapshot: snapshot({
        phase: 'provisioning',
        status: 'cleanup_required',
        error: {
          code: 'setup_failed',
          phase: 'provisioning',
          message: 'Setup failed after it may have modified the worktree.',
          retryable: false,
        },
        recoveryActions: ['retain', 'remove'],
      }),
      onAction,
    }))

    expect(markup).toContain('Setup failed after it may have modified the worktree.')
    expect(markup).toContain('The worktree was retained')
    expect(markup).toContain('Retain worktree')
    expect(markup).toContain('Remove worktree')
    expect(markup).not.toContain('Retry')
    expect(markup).not.toContain('Start in project')
  })

  it('shows an explicit reconnect instruction for a pending remote operation', () => {
    const markup = renderToStaticMarkup(createElement(WorktreeCreationProgress, {
      snapshot: snapshot({ phase: 'materializing' }),
      disconnected: true,
    }))

    expect(markup).toContain('Reconnect to continue tracking creation creation-progress-1.')
  })
})
