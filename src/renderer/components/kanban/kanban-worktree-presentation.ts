import type { WorktreeCreationSnapshot } from '../../../shared/worktree-creation'

export interface KanbanWorktreeCreationPresentation {
  label: string
  detail: string
  tone: 'error' | 'pending'
  recoverable: boolean
}

export function describeKanbanWorktreeCreation(
  snapshot: WorktreeCreationSnapshot | undefined,
): KanbanWorktreeCreationPresentation | null {
  if (!snapshot || snapshot.status === 'ready') return null
  if (snapshot.phase === 'provisioning' && snapshot.status === 'pending') {
    return {
      label: 'Agent launch pending',
      detail: 'The worktree is ready; backend agent launch is still pending.',
      tone: 'pending',
      recoverable: false,
    }
  }
  return {
    label: snapshot.status === 'failed' ? 'Worktree failed' : 'Worktree pending',
    detail: snapshot.error?.message ?? `Worktree creation is ${snapshot.phase}/${snapshot.status}.`,
    tone: snapshot.status === 'failed' || snapshot.status === 'cleanup_required' ? 'error' : 'pending',
    recoverable: snapshot.recoveryActions.length > 0,
  }
}
