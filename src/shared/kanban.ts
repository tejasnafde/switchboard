/**
 * Kanban — shared types between main and renderer.
 *
 * v1 model: a card is a unit of agent work scoped to one project.
 * Status drives column placement. Tags are user-controlled labels for
 * filtering/grouping. `costCapUsd` is an opt-in ceiling — when an
 * adapter reports cumulative cost ≥ cap we surface a needs-input flag
 * rather than auto-killing the run (the user might want to extend).
 *
 * `worktreePath` is set iff the card opted into an isolated git
 * worktree at create time. When present, terminal panes spawned inside
 * the card and the file viewer for the card's session are rooted at
 * the worktree, not the project path. `worktreeBranch` is the branch
 * the worktree is checked out to (typically `kanban/<short-id>`).
 */

import type { RuntimeMode } from './provider-events'

export type KanbanStatus = 'backlog' | 'in_progress' | 'needs_input' | 'done'

/** Default runtime mode for a new card; opt out via the create modal. */
export const KANBAN_DEFAULT_RUNTIME_MODE: RuntimeMode = 'accept-edits'

export const KANBAN_COLUMNS: ReadonlyArray<{ id: KanbanStatus; label: string }> = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'needs_input', label: 'Needs input' },
  { id: 'done', label: 'Done' },
]

export interface KanbanCard {
  id: string
  projectPath: string
  title: string
  description: string
  /** Free-form labels. Stored as a JSON string in SQLite. */
  tags: string[]
  status: KanbanStatus
  /** Optional spend ceiling in USD; null = no cap. */
  costCapUsd: number | null
  /** Initial runtime mode at launch. Not a live mirror — once a session exists, the chat panel owns the live mode. */
  runtimeMode: RuntimeMode
  /** Cumulative reported cost for the linked session. Null until first update. */
  costUsedUsd: number | null
  /** Set when the user clicks "Start" — links the card to a chat session. */
  conversationId: string | null
  /** Absolute path of the per-card git worktree, or null if the card uses the project's main checkout. */
  worktreePath: string | null
  /** Branch name the worktree is checked out to (only meaningful when worktreePath is set). */
  worktreeBranch: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface KanbanCardCreate {
  projectPath: string
  title: string
  description?: string
  tags?: string[]
  costCapUsd?: number | null
  /** Initial runtime mode for the agent. Defaults to `KANBAN_DEFAULT_RUNTIME_MODE` (`accept-edits`) when omitted. */
  runtimeMode?: RuntimeMode
  /** If true, the main process will create a git worktree under the project's `.switchboard/worktrees/` dir. */
  withWorktree?: boolean
}

export interface KanbanCardUpdate {
  title?: string
  description?: string
  tags?: string[]
  status?: KanbanStatus
  costCapUsd?: number | null
  costUsedUsd?: number | null
  conversationId?: string | null
}

/** Result of inspecting a project's `git worktree list --porcelain` output. */
export interface WorktreeInfo {
  /** Absolute filesystem path. */
  path: string
  /** Branch name (without refs/heads/), or null for detached HEAD. */
  branch: string | null
  /** HEAD commit SHA at inspection time. */
  head: string
  /** True if `git worktree list` reported the worktree as missing/prunable. */
  prunable: boolean
  /** True if a kanban card currently references this path. Set by the IPC layer. */
  inUse: boolean
}
