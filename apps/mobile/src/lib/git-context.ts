/**
 * The agent settings sheet's Workspace section: which branch the chat's
 * checkout is on, and whether that checkout is a worktree. Native Android
 * shows the same rows and copy (`GitContextPresenter`, `GitContextCoordinator`).
 */
import type { CurrentBranchResult } from './api'

export interface GitContextState {
  branch: string | null
  loading: boolean
  loaded: boolean
  missing: boolean
  error: string | null
}

export const INITIAL_GIT_CONTEXT: GitContextState = {
  branch: null,
  loading: false,
  loaded: false,
  missing: false,
  error: null,
}

export function gitContextLoading(state: GitContextState): GitContextState {
  return { ...state, loading: true, error: null }
}

export function gitContextAnswered(state: GitContextState, result: CurrentBranchResult): GitContextState {
  if (result.ok) return { ...INITIAL_GIT_CONTEXT, branch: result.branch || null, loaded: true }
  return { ...state, loading: false, loaded: true, missing: result.missing === true, error: result.error }
}

export function gitContextFailed(state: GitContextState, message: string): GitContextState {
  return { ...state, loading: false, loaded: true, error: message }
}

export interface GitContextPresentation {
  branchLabel: string
  checkoutLabel: string
  checkoutPath: string
  /** The project a worktree belongs to; null for the project checkout itself. */
  parentProjectPath: string | null
  loading: boolean
  error: string | null
}

export function presentGitContext(
  projectPath: string,
  worktreePath: string | null | undefined,
  state: GitContextState,
): GitContextPresentation {
  const worktree = worktreePath?.trim() ? worktreePath : null
  const branchLabel = state.branch
    ? state.branch
    : state.error !== null
      ? 'Branch unavailable'
      : state.loaded
        ? 'Detached HEAD'
        : 'Checking branch'
  return {
    branchLabel,
    checkoutLabel: worktree ? 'Worktree' : 'Project checkout',
    checkoutPath: worktree ?? projectPath,
    parentProjectPath: worktree && projectPath !== worktree ? projectPath : null,
    loading: state.loading,
    error: state.error,
  }
}
