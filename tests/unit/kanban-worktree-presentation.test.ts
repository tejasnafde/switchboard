import { describe, expect, it } from 'vitest'
import { describeKanbanWorktreeCreation } from '../../src/renderer/components/kanban/kanbanWorktreePresentation'
import type { WorktreeCreationSnapshot } from '../../src/shared/worktree-creation'

function snapshot(overrides: Partial<WorktreeCreationSnapshot>): WorktreeCreationSnapshot {
  return {
    creationId: 'creation-1',
    revision: 2,
    phase: 'materializing',
    status: 'pending',
    projectPath: '/repo',
    baseRef: 'HEAD',
    owner: { kind: 'kanban-card', cardId: 'card-1' },
    purpose: 'kanban',
    provenance: { surface: 'desktop', machineId: 'local', requestedAt: 1 },
    warnings: [],
    recoveryActions: [],
    updatedAt: 2,
    ...overrides,
  }
}

describe('Kanban worktree creation presentation', () => {
  it('surfaces a retryable materialization error on the preserved card', () => {
    expect(describeKanbanWorktreeCreation(snapshot({
      status: 'failed',
      error: { code: 'git', phase: 'materializing', message: 'Branch exists.', retryable: true },
      recoveryActions: ['retry'],
    }))).toEqual({
      label: 'Worktree failed',
      detail: 'Branch exists.',
      tone: 'error',
      recoverable: true,
    })
  })

  it('makes the current Kanban owner launch gap explicit', () => {
    expect(describeKanbanWorktreeCreation(snapshot({
      phase: 'provisioning',
      status: 'pending',
    }))).toEqual({
      label: 'Agent launch pending',
      detail: 'The worktree is ready; backend agent launch is still pending.',
      tone: 'pending',
      recoverable: false,
    })
  })

  it('does not add transaction noise after the worktree is ready', () => {
    expect(describeKanbanWorktreeCreation(snapshot({ phase: 'ready', status: 'ready' }))).toBeNull()
  })
})
