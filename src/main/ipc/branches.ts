/**
 * Branches-screen IPC handlers — DAG CRUD, dry-run/execute orchestration,
 * conflict-resolution rendezvous, and crash-recovery.
 *
 * The DAG lives in SQLite (`worktree_dependencies`); the in-flight plan
 * state lives in `branch_plan_state`. Long-running operations
 * (dry-run, execute) push progress to the renderer via the
 * `BranchesChannels.EVENT` channel.
 *
 * Pattern matches `kanban.ts` (project-scoped, file-per-feature). The
 * orchestration logic itself lives in `src/main/branches/*` and is
 * unit-tested with injected git ops; this file is the thin IPC seam
 * that binds those modules to live `ipcMain.handle` channels.
 */

import { ipcMain, type BrowserWindow } from 'electron'
import { BranchesChannels } from '@shared/ipc-channels'
import { createMainLogger } from '../logger'
import {
  addWorktreeDependency,
  removeWorktreeDependency,
  listWorktreeDependencies,
  saveBranchPlanState,
  loadBranchPlanState,
  clearBranchPlanState,
} from '../db/database'
import {
  listWorktrees,
  statusPorcelain,
  mergeTreeWriteTree,
  rebaseOnto,
  rebaseAbort,
  isInsideRebase,
  currentBranchOf,
  gitVersion,
  defaultGitRunner,
} from '../worktree'
import {
  mergePlan as buildMergePlan,
  type Plan,
} from '../branches/dependencyGraph'
import {
  dryRunPlan,
  executePlan as runExecutePlan,
  resumePlan as runResumePlan,
  DirtyWorktreeError,
  PlanAbortedError,
  type ExecuteCallbacks,
  type MergePlannerDeps,
} from '../branches/mergePlanner'
import { detectOverlaps } from '../branches/overlapDetector'
import {
  detectMergiraf,
  installMergirafDriver,
  ensureGitattributesEntry,
  resetMergirafCache,
} from '../branches/mergeDriver'
import { enableRerere, isRerereEnabled } from '../branches/rerere'
import {
  isResumablePlanStatus,
  type BranchesView,
  type BranchesEvent,
  type DryRunReportWire,
  type PlanWire,
  type PendingPlanState,
} from '@shared/branches'

const log = createMainLogger('ipc:branches')

/* -------------------------------------------------------------------------- */
/* Conflict-resolution rendezvous                                             */
/*                                                                            */
/* The planner pauses on conflict and awaits a callback. Each repo's          */
/* in-flight plan stashes a Promise resolver here; the renderer's             */
/* RESOLVE_CONFLICT IPC fires it.                                             */
/* -------------------------------------------------------------------------- */

type ConflictResolver = (decision: 'continue' | 'abort') => void
const pendingResolvers = new Map<string, ConflictResolver>()

function arrivedConflictResolution(repoPath: string, decision: 'continue' | 'abort'): void {
  const resolver = pendingResolvers.get(repoPath)
  if (resolver) {
    pendingResolvers.delete(repoPath)
    resolver(decision)
  } else {
    log.warn(`resolve-conflict: no pending resolver for ${repoPath}`)
  }
}

function awaitConflictResolution(repoPath: string): Promise<'continue' | 'abort'> {
  return new Promise<'continue' | 'abort'>((resolve) => {
    pendingResolvers.set(repoPath, resolve)
  })
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Module-scope planner deps. No closure dependencies, so it doesn't
 *  need to live inside `registerBranchesHandlers`. */
const plannerDeps: MergePlannerDeps = {
  statusPorcelain: (cwd) => statusPorcelain(cwd, defaultGitRunner),
  mergeTreeWriteTree: (cwd, base, head) =>
    mergeTreeWriteTree(cwd, base, head, defaultGitRunner),
  rebaseOnto: (cwd, base) => rebaseOnto(cwd, base, defaultGitRunner),
  rebaseAbort: (cwd) => rebaseAbort(cwd, defaultGitRunner),
  runner: defaultGitRunner,
  persist: {
    save: async (a) => saveBranchPlanState(a),
    clear: async (p) => clearBranchPlanState(p),
  },
}

async function buildBranchesView(repoPath: string): Promise<BranchesView> {
  const worktrees = await listWorktrees(repoPath, defaultGitRunner)
  const nodes = worktrees
    .filter((w) => w.branch !== null)
    .map((w) => ({ branch: w.branch as string, worktreePath: w.path, head: w.head }))
  const edgeRows = listWorktreeDependencies(repoPath)

  // All probes are independent — fan out, then await the slowest.
  const [versionRes, mergiraf, rerereOn, trunkBranch, dirtyResults] = await Promise.all([
    gitVersion().catch(() => null),
    detectMergiraf().catch(() => ({ found: false } as const)),
    isRerereEnabled(repoPath, defaultGitRunner).catch(() => false),
    currentBranchOf(repoPath, defaultGitRunner).catch(() => null),
    Promise.all(
      nodes.map((n) =>
        statusPorcelain(n.worktreePath, defaultGitRunner)
          .then((s) => ({ path: n.worktreePath, dirty: s.trim() !== '' }))
          .catch(() => ({ path: n.worktreePath, dirty: false })),
      ),
    ),
  ])

  const mergeTreeSupported = !!versionRes && (versionRes.major > 2 || (versionRes.major === 2 && versionRes.minor >= 38))
  const dirty = dirtyResults.filter((r) => r.dirty).map((r) => r.path)

  const persisted = loadBranchPlanState(repoPath)
  let pendingPlan: PendingPlanState | null = null
  if (persisted && isResumablePlanStatus(persisted.status)) {
    try {
      const plan = JSON.parse(persisted.plan_json) as Plan
      pendingPlan = {
        currentStep: persisted.current_step,
        status: persisted.status,
        totalSteps: plan.steps.length,
        trunk: plan.trunk,
        remaining: plan.steps.slice(persisted.current_step).map((s) => ({
          branch: s.branch,
          worktreePath: s.worktreePath,
        })),
        updatedAt: persisted.updated_at,
      }
    } catch (err) {
      log.warn(`failed to parse persisted plan_json for ${repoPath}: ${err}`)
    }
  }

  return {
    repoPath,
    trunk: trunkBranch ?? 'main',
    mergeTreeSupported,
    mergirafReady: mergiraf.found,
    rerereEnabled: rerereOn,
    nodes,
    edges: edgeRows.map((r) => ({
      parent: r.parent_branch,
      child: r.child_branch,
      createdAt: r.created_at,
    })),
    suggestedEdges: [],
    pendingPlan,
    dirtyWorktrees: dirty,
  }
}

function makeCallbacks(repoPath: string, emit: (e: BranchesEvent) => void): ExecuteCallbacks {
  return {
    onStepStart: (step, index) => emit({ kind: 'step.started', index, branch: step.branch }),
    onStepComplete: (step, index) => emit({ kind: 'step.completed', index, branch: step.branch }),
    onConflict: async ({ step, conflictFiles, index }) => {
      emit({ kind: 'conflict.opened', index, branch: step.branch, conflictFiles })
      return await awaitConflictResolution(repoPath)
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Handler registration                                                       */
/* -------------------------------------------------------------------------- */

export function registerBranchesHandlers(window: BrowserWindow): void {
  for (const ch of Object.values(BranchesChannels)) {
    try { ipcMain.removeHandler(ch) } catch { /* not registered yet */ }
  }

  const emit = (event: BranchesEvent): void => {
    if (!window.isDestroyed()) {
      window.webContents.send(BranchesChannels.EVENT, event)
    }
  }

  ipcMain.handle(BranchesChannels.LIST, async (_e, repoPath: string) => {
    return buildBranchesView(repoPath)
  })

  ipcMain.handle(BranchesChannels.ADD_EDGE, async (
    _e,
    args: { repoPath: string; parent: string; child: string },
  ) => {
    addWorktreeDependency(args.repoPath, args.parent, args.child)
    log.info(`+edge ${args.parent} → ${args.child} in ${args.repoPath}`)
    return { ok: true }
  })

  ipcMain.handle(BranchesChannels.REMOVE_EDGE, async (
    _e,
    args: { repoPath: string; parent: string; child: string },
  ) => {
    removeWorktreeDependency(args.repoPath, args.parent, args.child)
    log.info(`-edge ${args.parent} → ${args.child} in ${args.repoPath}`)
    return { ok: true }
  })

  ipcMain.handle(BranchesChannels.PLAN, async (_e, repoPath: string) => {
    const view = await buildBranchesView(repoPath)
    const plan = buildMergePlan({
      nodes: view.nodes,
      edges: view.edges.map((e) => ({ parent: e.parent, child: e.child })),
      trunk: view.trunk,
    })
    const planWire: PlanWire = {
      trunk: plan.trunk,
      steps: plan.steps.map((s) => ({
        branch: s.branch,
        worktreePath: s.worktreePath,
        parallelGroup: s.parallelGroup,
      })),
    }
    const dryRun: DryRunReportWire[] = view.mergeTreeSupported
      ? (await dryRunPlan(plan, repoPath, plannerDeps)).map((r) => ({
          step: {
            branch: r.step.branch,
            worktreePath: r.step.worktreePath,
            parallelGroup: r.step.parallelGroup,
          },
          conflictFiles: r.conflictFiles,
          conflicted: r.conflicted,
          treeSha: r.treeSha,
        }))
      : []
    return { plan: planWire, dryRun, dirtyWorktrees: view.dirtyWorktrees }
  })

  ipcMain.handle(BranchesChannels.EXECUTE, async (_e, repoPath: string) => {
    const view = await buildBranchesView(repoPath)
    const plan = buildMergePlan({
      nodes: view.nodes,
      edges: view.edges.map((e) => ({ parent: e.parent, child: e.child })),
      trunk: view.trunk,
    })
    try {
      await runExecutePlan(plan, repoPath, plannerDeps, makeCallbacks(repoPath, emit))
      emit({ kind: 'plan.completed' })
      return { ok: true }
    } catch (err) {
      if (err instanceof DirtyWorktreeError) {
        emit({ kind: 'plan.failed', message: err.message })
        return { ok: false, error: err.message, dirty: err.dirtyPaths }
      }
      if (err instanceof PlanAbortedError) {
        emit({ kind: 'plan.aborted', atStep: err.atStep, branch: err.branch })
        return { ok: false, error: err.message, aborted: true }
      }
      const message = err instanceof Error ? err.message : String(err)
      log.error(`execute failed: ${message}`)
      emit({ kind: 'plan.failed', message })
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(BranchesChannels.RESUME, async (_e, repoPath: string) => {
    const persisted = loadBranchPlanState(repoPath)
    if (!persisted) return { ok: false, error: 'no plan to resume' }
    let plan: Plan
    try {
      plan = JSON.parse(persisted.plan_json) as Plan
    } catch (err) {
      const message = `corrupt persisted plan: ${err}`
      log.error(message)
      return { ok: false, error: message }
    }
    try {
      await runResumePlan(plan, persisted.current_step, repoPath, plannerDeps, makeCallbacks(repoPath, emit))
      emit({ kind: 'plan.completed' })
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emit({ kind: 'plan.failed', message })
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(BranchesChannels.RESOLVE_CONFLICT, async (
    _e,
    args: { repoPath: string; decision: 'continue' | 'abort' },
  ) => {
    arrivedConflictResolution(args.repoPath, args.decision)
    return { ok: true }
  })

  ipcMain.handle(BranchesChannels.ABORT, async (_e, repoPath: string) => {
    if (pendingResolvers.has(repoPath)) {
      arrivedConflictResolution(repoPath, 'abort')
    }
    const persisted = loadBranchPlanState(repoPath)
    if (persisted) {
      try {
        const plan = JSON.parse(persisted.plan_json) as Plan
        const cur = plan.steps[persisted.current_step]
        if (cur) {
          const inRebase = await isInsideRebase(cur.worktreePath, defaultGitRunner).catch(() => false)
          if (inRebase) await rebaseAbort(cur.worktreePath, defaultGitRunner)
        }
      } catch (err) {
        log.warn(`abort: failed to clean rebase state — ${err}`)
      }
    }
    clearBranchPlanState(repoPath)
    return { ok: true }
  })

  ipcMain.handle(BranchesChannels.SUGGEST_EDGES, async (_e, repoPath: string) => {
    const view = await buildBranchesView(repoPath)
    if (!view.mergeTreeSupported) return { suggestedEdges: [] }
    const edgeKeys = new Set(view.edges.flatMap((e) => [`${e.parent}->${e.child}`, `${e.child}->${e.parent}`]))
    const existingEdge = (parent: string, child: string): boolean =>
      edgeKeys.has(`${parent}->${child}`)
    const suggestions = await detectOverlaps(view.nodes, repoPath, {
      mergeTreeWriteTree: (cwd, base, head) => mergeTreeWriteTree(cwd, base, head, defaultGitRunner),
      branchTimestamp: async (branch) => {
        try {
          const { stdout } = await defaultGitRunner(['log', '-1', '--format=%ct', branch], repoPath)
          return Number(stdout.trim()) || 0
        } catch {
          return 0
        }
      },
      existingEdge,
    })
    return { suggestedEdges: suggestions }
  })

  ipcMain.handle(BranchesChannels.CONFIGURE_REPO, async (
    _e,
    args: { repoPath: string; enableRerere?: boolean; installMergiraf?: boolean },
  ) => {
    const out: { rerereEnabled: boolean; mergirafReady: boolean } = {
      rerereEnabled: false,
      mergirafReady: false,
    }
    if (args.enableRerere) {
      await enableRerere(args.repoPath, defaultGitRunner)
      out.rerereEnabled = true
    } else {
      out.rerereEnabled = await isRerereEnabled(args.repoPath, defaultGitRunner).catch(() => false)
    }
    // Bust the mergiraf cache before re-probing — the user may have
    // just `brew install`-ed it and the previous probe said `not found`.
    if (args.installMergiraf) resetMergirafCache()
    const probe = await detectMergiraf().catch(() => ({ found: false } as const))
    if (args.installMergiraf && probe.found) {
      await installMergirafDriver(args.repoPath, defaultGitRunner)
      await ensureGitattributesEntry(args.repoPath)
      out.mergirafReady = true
    } else {
      out.mergirafReady = probe.found
    }
    return out
  })

  log.info('IPC handlers registered')
}
