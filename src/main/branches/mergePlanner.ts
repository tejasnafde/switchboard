/**
 * Merge orchestrator for the Branches screen.
 *
 * Walks a `Plan.steps` in toposort order. For each step:
 *   1. Pre-flight: every involved worktree must be clean.
 *   2. Rebase the worktree onto trunk.
 *   3. On conflict → callback to UI; UI resolves; we resume.
 *   4. Fast-forward merge into trunk in the main repo.
 *   5. Persist plan-state after each step so a crash mid-flight can
 *      resume on next launch.
 *
 * Pure orchestration — every git op + the persistence layer is
 * injected via `MergePlannerDeps`. Production wiring happens in the
 * IPC handler (src/main/ipc/app.ts).
 */

import type {
  Plan,
  PlanStep,
} from './dependencyGraph'
import type {
  MergeTreeResult,
  RebaseResult,
} from '../worktree'
import type {
  GitRunner,
} from '../worktree'
import type { BranchPlanStatus } from '@shared/branches'

export interface MergePlannerDeps {
  statusPorcelain: (cwd: string) => Promise<string>
  mergeTreeWriteTree: (cwd: string, base: string, head: string) => Promise<MergeTreeResult>
  rebaseOnto: (cwd: string, newBase: string) => Promise<RebaseResult>
  /** Smart rebase abort — swallows "no rebase in progress" only. */
  rebaseAbort: (cwd: string) => Promise<void>
  /** Raw runner for ad-hoc git commands (`merge --ff-only`,
   *  `rebase --continue`). */
  runner: GitRunner
  /** The planner only writes plan state (clear at the end, save
   *  per step). Loading is the caller's responsibility — `resumePlan`
   *  takes the deserialized plan + resume index, not a row. */
  persist: {
    save: (args: {
      repoPath: string
      planJson: string
      currentStep: number
      status: BranchPlanStatus
    }) => Promise<void>
    clear: (repoPath: string) => Promise<void>
  }
}

export interface ExecuteCallbacks {
  onStepStart?: (step: PlanStep, index: number) => void
  onStepComplete?: (step: PlanStep, index: number) => void
  /** Called when a step's rebase pauses on conflict. The UI surfaces
   *  the conflict, the user resolves on disk, and the callback resolves
   *  with `'continue'` (we run `rebase --continue`) or `'abort'`
   *  (we run `rebase --abort` and bail). */
  onConflict: (args: {
    step: PlanStep
    conflictFiles: string[]
    index: number
  }) => Promise<'continue' | 'abort'>
}

export interface DryRunReport {
  step: PlanStep
  conflictFiles: string[]
  conflicted: boolean
  treeSha: string | null
}

export class DirtyWorktreeError extends Error {
  constructor(public readonly dirtyPaths: string[]) {
    super(`Refusing to plan: dirty worktree(s) — ${dirtyPaths.join(', ')}`)
    this.name = 'DirtyWorktreeError'
  }
}

export class PlanAbortedError extends Error {
  constructor(public readonly atStep: number, public readonly branch: string) {
    super(`Plan aborted by user at step ${atStep} (branch ${branch})`)
    this.name = 'PlanAbortedError'
  }
}

/* -------------------------------------------------------------------------- */
/* Pre-flight                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Throws `DirtyWorktreeError` listing every dirty path. Caller is
 * expected to surface a sensible UI ("Stash or commit before merging").
 * We never auto-stash — too easy to lose work.
 */
export async function assertAllClean(
  worktreePaths: string[],
  deps: Pick<MergePlannerDeps, 'statusPorcelain'>,
): Promise<void> {
  const dirty: string[] = []
  for (const p of worktreePaths) {
    const out = await deps.statusPorcelain(p)
    if (out.trim() !== '') dirty.push(p)
  }
  if (dirty.length > 0) throw new DirtyWorktreeError(dirty)
}

/* -------------------------------------------------------------------------- */
/* Dry run                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Predict per-step conflicts without modifying any worktree. For each
 * step, run `git merge-tree --write-tree trunk <step.branch>` from the
 * main repo and report the conflict file list.
 *
 * NOTE — this is necessary-not-sufficient: it predicts pairwise conflicts
 * with *current* trunk only, not cross-step interactions. The doc covers
 * this caveat; the UI should surface it.
 */
export async function dryRunPlan(
  plan: Plan,
  mainRepoPath: string,
  deps: MergePlannerDeps,
): Promise<DryRunReport[]> {
  const out: DryRunReport[] = []
  for (const step of plan.steps) {
    const result = await deps.mergeTreeWriteTree(mainRepoPath, plan.trunk, step.branch)
    out.push({
      step,
      conflictFiles: result.conflictFiles,
      conflicted: result.conflicted,
      treeSha: result.treeSha,
    })
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Execute / resume                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Execute the plan from step 0. Persists progress after each step so a
 * crash leaves resumable state behind.
 */
export async function executePlan(
  plan: Plan,
  mainRepoPath: string,
  deps: MergePlannerDeps,
  callbacks: ExecuteCallbacks,
): Promise<void> {
  await assertAllClean(plan.steps.map((s) => s.worktreePath), deps)
  await runStepsFrom(plan, mainRepoPath, 0, deps, callbacks)
}

/**
 * Resume a previously persisted plan from `fromIndex`. We do not
 * re-clean-check: the user knows what they're doing if they hit
 * "Resume" — and an in-progress rebase will keep the worktree at
 * REBASE_HEAD which we expect to surface upstream.
 *
 * Caller (the IPC handler) is responsible for deserializing the
 * persisted row before calling this — keeps the planner free of
 * persistence-format awareness.
 */
export async function resumePlan(
  plan: Plan,
  fromIndex: number,
  mainRepoPath: string,
  deps: MergePlannerDeps,
  callbacks: ExecuteCallbacks,
): Promise<void> {
  await runStepsFrom(plan, mainRepoPath, fromIndex, deps, callbacks)
}

async function runStepsFrom(
  plan: Plan,
  mainRepoPath: string,
  fromIndex: number,
  deps: MergePlannerDeps,
  callbacks: ExecuteCallbacks,
): Promise<void> {
  const planJson = JSON.stringify(plan)
  // Mark running on entry so the UI can show "Plan in progress"
  await deps.persist.save({
    repoPath: mainRepoPath,
    planJson,
    currentStep: fromIndex,
    status: 'running',
  })

  for (let i = fromIndex; i < plan.steps.length; i++) {
    const step = plan.steps[i]
    callbacks.onStepStart?.(step, i)

    // 1. Rebase onto trunk. On conflict, hand off to the UI.
    let rebase = await deps.rebaseOnto(step.worktreePath, plan.trunk)
    while (rebase.status === 'conflict') {
      await deps.persist.save({
        repoPath: mainRepoPath,
        planJson,
        currentStep: i,
        status: 'paused',
      })
      const decision = await callbacks.onConflict({
        step,
        conflictFiles: rebase.conflictFiles,
        index: i,
      })
      if (decision === 'abort') {
        await deps.rebaseAbort(step.worktreePath).catch(() => undefined)
        await deps.persist.save({
          repoPath: mainRepoPath,
          planJson,
          currentStep: i,
          status: 'failed',
        })
        throw new PlanAbortedError(i, step.branch)
      }
      // User resolved on disk; staged the result; we run `rebase --continue`.
      // If the rebase still has more commits to apply and they conflict again,
      // we loop back. `runner` rejects on non-zero, so we re-query
      // unmerged-files to detect that.
      try {
        await deps.runner(['rebase', '--continue'], step.worktreePath)
        rebase = { status: 'clean', conflictFiles: [] }
      } catch {
        // Continue raised — there are still unmerged paths
        const out = await deps.runner(
          ['diff', '--name-only', '--diff-filter=U'],
          step.worktreePath,
        )
        rebase = {
          status: 'conflict',
          conflictFiles: out.stdout.split('\n').filter((l) => l.length > 0),
        }
      }
    }

    // 2. Fast-forward merge into trunk in the main repo. This is what
    //    actually advances `main` between steps — the rebase only
    //    aligned the worktree's tip onto trunk's HEAD.
    await deps.runner(['merge', '--ff-only', step.branch], mainRepoPath)

    callbacks.onStepComplete?.(step, i)
    await deps.persist.save({
      repoPath: mainRepoPath,
      planJson,
      currentStep: i + 1,
      status: i + 1 === plan.steps.length ? 'done' : 'running',
    })
  }

  // All steps complete — drop the persisted state so the resume banner
  // doesn't fire on next launch.
  await deps.persist.clear(mainRepoPath)
}
