import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildKanbanCardCreateSubmission } from '../../src/renderer/components/kanban/kanbanCreateIntent'

describe('Kanban card create intent', () => {
  it('stores the initial agent prompt and runtime mode with a worktree request', () => {
    expect(buildKanbanCardCreateSubmission({
      projectPath: '/repo',
      title: 'Fix transaction',
      description: 'Keep the card recoverable.',
      tags: ['backend'],
      costCapUsd: 8,
      runtimeMode: 'plan',
      status: 'backlog',
      withWorktree: true,
    })).toMatchObject({
      withWorktree: true,
      status: 'backlog',
      worktreeCreation: {
        initialAgent: {
          provider: 'claude-code',
          runtimeMode: 'plan',
          prompt: 'Fix transaction\n\nKeep the card recoverable.',
        },
      },
    })
  })

  it('preserves the chosen status without asking for backend launch for a plain card', () => {
    const submission = buildKanbanCardCreateSubmission({
      projectPath: '/repo',
      title: 'Backlog only',
      description: '',
      tags: [],
      costCapUsd: null,
      runtimeMode: 'accept-edits',
      status: 'needs_input',
      withWorktree: false,
    })
    expect(submission).toMatchObject({ status: 'needs_input' })
    expect(submission.worktreeCreation).toBeUndefined()
  })

  it('does not retain the renderer-owned create-then-launch orchestration', () => {
    const source = readFileSync(
      new URL('../../src/renderer/components/kanban/CardModal.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).not.toContain('launchCardChat(newCard')
    expect(source).not.toContain('beginCardLaunch(newCard.id)')
  })
})
