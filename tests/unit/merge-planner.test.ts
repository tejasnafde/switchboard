/**
 * Tests for the merge orchestrator — the engine that walks a `Plan`,
 * rebases each worktree, and pauses on conflict.
 *
 * All git ops (`statusPorcelain`, `mergeTreeWriteTree`, `rebaseOnto`,
 * raw `runner`) are injected. The persist layer (which is SQLite-backed
 * in production) is also mocked. So we can exhaustively exercise the
 * orchestration: dry-run reporting, dirty-tree refusal, conflict
 * pause/resume, plan-state persistence each step.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  dryRunPlan,
  executePlan,
  assertAllClean,
  resumePlan,
  DirtyWorktreeError,
} from '../../src/main/branches/mergePlanner'
import type {
  MergePlannerDeps,
  ExecuteCallbacks,
} from '../../src/main/branches/mergePlanner'
import type { Plan, PlanStep } from '../../src/main/branches/dependencyGraph'

const REPO = '/repo'

function mkPlan(branches: string[]): Plan {
  return {
    trunk: 'main',
    steps: branches.map<PlanStep>((b, i) => ({
      branch: b,
      worktreePath: `/repo/.switchboard/worktrees/${b}`,
      parallelGroup: i,
    })),
  }
}

interface MockState {
  saved: Array<{ currentStep: number; status: string }>
  cleared: number
  cleanTrees: Set<string> // worktree paths reported clean
  conflictsByBranch: Record<string, string[]> // dry-run mock
  rebaseConflicts: Record<string, string[]> // execute mock
}

function makeDeps(state: MockState): MergePlannerDeps {
  return {
    statusPorcelain: vi.fn(async (cwd: string) => (state.cleanTrees.has(cwd) ? '' : ' M dirty.ts\n')),
    mergeTreeWriteTree: vi.fn(async (_cwd, _base, head) => {
      const conflicts = state.conflictsByBranch[head] ?? []
      return {
        treeSha: 'tree-sha',
        conflictFiles: conflicts,
        conflicted: conflicts.length > 0,
      }
    }),
    rebaseOnto: vi.fn(async (cwd: string, _newBase: string) => {
      const branch = cwd.split('/').pop()!
      const conflicts = state.rebaseConflicts[branch] ?? []
      return {
        status: conflicts.length > 0 ? ('conflict' as const) : ('clean' as const),
        conflictFiles: conflicts,
      }
    }),
    rebaseAbort: vi.fn(async () => undefined),
    runner: vi.fn(async () => ({ stdout: '', stderr: '' })),
    persist: {
      save: vi.fn(async (args) => {
        state.saved.push({ currentStep: args.currentStep, status: args.status })
      }),
      clear: vi.fn(async () => { state.cleared += 1 }),
    },
  }
}

const cleanState = (paths: string[]): MockState => ({
  saved: [],
  cleared: 0,
  cleanTrees: new Set(paths),
  conflictsByBranch: {},
  rebaseConflicts: {},
})

describe('assertAllClean', () => {
  it('succeeds when every worktree is clean', async () => {
    const state = cleanState(['/a', '/b'])
    const deps = makeDeps(state)
    await expect(assertAllClean(['/a', '/b'], deps)).resolves.toBeUndefined()
  })

  it('throws DirtyWorktreeError naming the dirty paths', async () => {
    const state = cleanState(['/a']) // /b is dirty
    const deps = makeDeps(state)
    await expect(assertAllClean(['/a', '/b'], deps)).rejects.toBeInstanceOf(DirtyWorktreeError)
    await expect(assertAllClean(['/a', '/b'], deps)).rejects.toThrow(/\/b/)
  })
})

describe('dryRunPlan', () => {
  it('reports per-step conflict files via mergeTreeWriteTree', async () => {
    const plan = mkPlan(['a', 'b'])
    const state = cleanState(plan.steps.map((s) => s.worktreePath))
    state.conflictsByBranch.b = ['foo.ts']
    const deps = makeDeps(state)
    const report = await dryRunPlan(plan, REPO, deps)
    expect(report).toHaveLength(2)
    expect(report[0].conflicted).toBe(false)
    expect(report[1].conflicted).toBe(true)
    expect(report[1].conflictFiles).toEqual(['foo.ts'])
    // mergeTreeWriteTree was called with (repo, 'main', 'a') and (repo, 'main', 'b')
    expect(deps.mergeTreeWriteTree).toHaveBeenNthCalledWith(1, REPO, 'main', 'a')
    expect(deps.mergeTreeWriteTree).toHaveBeenNthCalledWith(2, REPO, 'main', 'b')
  })

  it('returns an empty array for an empty plan', async () => {
    const state = cleanState([])
    const deps = makeDeps(state)
    expect(await dryRunPlan(mkPlan([]), REPO, deps)).toEqual([])
  })
})

describe('executePlan', () => {
  it('refuses to start when any worktree is dirty', async () => {
    const plan = mkPlan(['a', 'b'])
    const state = cleanState([plan.steps[0].worktreePath]) // b is dirty
    const deps = makeDeps(state)
    const cb: ExecuteCallbacks = { onConflict: vi.fn(async () => 'abort') }
    await expect(executePlan(plan, REPO, deps, cb)).rejects.toBeInstanceOf(DirtyWorktreeError)
    expect(deps.rebaseOnto).not.toHaveBeenCalled()
  })

  it('rebases each worktree in plan order, ff-merges into trunk, and persists progress', async () => {
    const plan = mkPlan(['a', 'b', 'c'])
    const state = cleanState(plan.steps.map((s) => s.worktreePath))
    const deps = makeDeps(state)
    const completed: string[] = []
    const cb: ExecuteCallbacks = {
      onStepComplete: (step) => { completed.push(step.branch) },
      onConflict: vi.fn(async () => 'abort'),
    }
    await executePlan(plan, REPO, deps, cb)
    expect(completed).toEqual(['a', 'b', 'c'])
    expect(deps.rebaseOnto).toHaveBeenCalledTimes(3)
    // Each step ff-merges into trunk via the runner: `merge --ff-only <branch>`
    const ffCalls = (deps.runner as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => Array.isArray(c[0]) && c[0][0] === 'merge')
    expect(ffCalls).toHaveLength(3)
    expect(ffCalls[0][0]).toEqual(['merge', '--ff-only', 'a'])
    // Plan state persisted at each step: progress + final 'done'
    const statuses = state.saved.map((s) => s.status)
    expect(statuses[statuses.length - 1]).toBe('done')
    expect(state.cleared).toBe(1) // clean-up at end
  })

  it('pauses on conflict, calls onConflict, continues when caller returns "continue"', async () => {
    const plan = mkPlan(['a', 'b'])
    const state = cleanState(plan.steps.map((s) => s.worktreePath))
    state.rebaseConflicts.a = ['foo.ts']
    const deps = makeDeps(state)
    const onConflict = vi.fn(async () => 'continue' as const)
    const cb: ExecuteCallbacks = { onConflict }
    await executePlan(plan, REPO, deps, cb)
    expect(onConflict).toHaveBeenCalledOnce()
    expect(onConflict.mock.calls[0][0].conflictFiles).toEqual(['foo.ts'])
    // After conflict resolution, planner runs `rebase --continue` on 'a'
    const rebaseContinueCall = (deps.runner as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => Array.isArray(c[0]) && c[0][0] === 'rebase' && c[0][1] === '--continue',
    )
    expect(rebaseContinueCall).toBeTruthy()
  })

  it('aborts the plan when caller returns "abort"', async () => {
    const plan = mkPlan(['a', 'b'])
    const state = cleanState(plan.steps.map((s) => s.worktreePath))
    state.rebaseConflicts.a = ['foo.ts']
    const deps = makeDeps(state)
    const cb: ExecuteCallbacks = { onConflict: async () => 'abort' }
    await expect(executePlan(plan, REPO, deps, cb)).rejects.toThrow(/abort/i)
    // 'b' never started
    expect(deps.rebaseOnto).toHaveBeenCalledTimes(1)
    // Status persisted as 'failed'
    const statuses = state.saved.map((s) => s.status)
    expect(statuses).toContain('failed')
  })
})

describe('resumePlan', () => {
  it('skips already-completed steps and resumes from currentStep', async () => {
    const plan = mkPlan(['a', 'b', 'c'])
    const state = cleanState(plan.steps.map((s) => s.worktreePath))
    const deps = makeDeps(state)
    const completed: string[] = []
    const cb: ExecuteCallbacks = {
      onStepComplete: (step) => completed.push(step.branch),
      onConflict: async () => 'abort',
    }
    // Resume from step 2 (only 'c' remains)
    await resumePlan(plan, 2, REPO, deps, cb)
    expect(completed).toEqual(['c'])
    expect(deps.rebaseOnto).toHaveBeenCalledTimes(1)
    const ffCalls = (deps.runner as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => Array.isArray(c[0]) && c[0][0] === 'merge')
    expect(ffCalls).toEqual([[['merge', '--ff-only', 'c'], REPO]])
  })
})
