/**
 * Wire-format types for the Branches screen IPC. Imported by both the
 * main-process IPC handler and the renderer store/components — single
 * source of truth.
 */

export type BranchPlanStatus = 'pending' | 'running' | 'paused' | 'failed' | 'done'

/** Whether a persisted plan is still actionable from the resume banner. */
export function isResumablePlanStatus(s: BranchPlanStatus): boolean {
  return s === 'paused' || s === 'running' || s === 'failed'
}

export interface BranchNodeWire {
  branch: string
  worktreePath: string
  head: string
}

export interface BranchEdgeWire {
  parent: string
  child: string
  /** Unix-ms timestamp at which the edge was authored. Used for
   *  ordering in the UI (oldest edge → top). */
  createdAt: number
}

export interface SuggestedEdgeWire {
  parent: string
  child: string
  conflictFiles: string[]
}

/** What `branches:list` returns. */
export interface BranchesView {
  repoPath: string
  trunk: string
  /** Whether `git --version` clears the 2.38 gate for `merge-tree --write-tree`. */
  mergeTreeSupported: boolean
  /** Whether mergiraf is on PATH and the driver config is installed. */
  mergirafReady: boolean
  rerereEnabled: boolean
  nodes: BranchNodeWire[]
  edges: BranchEdgeWire[]
  suggestedEdges: SuggestedEdgeWire[]
  /** A persisted plan (paused / failed / mid-run) means the user can
   *  resume or abort. Null when no plan is in flight. */
  pendingPlan: PendingPlanState | null
  dirtyWorktrees: string[]
}

export interface PendingPlanState {
  currentStep: number
  status: BranchPlanStatus
  totalSteps: number
  trunk: string
  /** Paths and branches of the steps still to run. */
  remaining: Array<{ branch: string; worktreePath: string }>
  updatedAt: number
}

export interface PlanStepWire {
  branch: string
  worktreePath: string
  parallelGroup: number
}

export interface DryRunReportWire {
  step: PlanStepWire
  conflictFiles: string[]
  conflicted: boolean
  treeSha: string | null
}

export interface PlanWire {
  trunk: string
  steps: PlanStepWire[]
}

export type BranchesEvent =
  | { kind: 'step.started'; index: number; branch: string }
  | { kind: 'step.completed'; index: number; branch: string }
  | {
      kind: 'conflict.opened'
      index: number
      branch: string
      conflictFiles: string[]
    }
  | { kind: 'plan.completed' }
  | { kind: 'plan.aborted'; atStep: number; branch: string }
  | { kind: 'plan.failed'; message: string }
