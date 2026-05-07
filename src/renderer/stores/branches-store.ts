/**
 * Branches store — the dependency graph + plan state, keyed by repo
 * path. Mirrors `kanban-store.ts`: source of truth lives in main
 * (SQLite + git), we hydrate on screen open and re-hydrate after each
 * mutation. No optimistic updates — graph mutations are infrequent and
 * human-paced.
 *
 * Plan execution is special: the renderer subscribes to
 * `BranchesChannels.EVENT` while a plan is running so step progress +
 * conflicts surface live. When a `conflict.opened` arrives, we hold it
 * in `activeConflict` and let `ConflictResolutionPanel` resolve it via
 * `resolveConflict`.
 */

import { create } from 'zustand'
import type {
  BranchesView,
  BranchesEvent,
  PlanWire,
  DryRunReportWire,
  SuggestedEdgeWire,
} from '@shared/branches'

const PLAN_TERMINAL_KINDS = new Set<BranchesEvent['kind']>([
  'plan.completed',
  'plan.aborted',
  'plan.failed',
])

let eventBridgeStarted = false

export interface ConflictPrompt {
  index: number
  branch: string
  conflictFiles: string[]
}

export interface BranchesPerRepo {
  view: BranchesView
  /** Latest computed plan + dry-run. Null until "Plan merge" clicked. */
  lastPlan: { plan: PlanWire; dryRun: DryRunReportWire[]; dirtyWorktrees: string[] } | null
  /** True while EXECUTE / RESUME is in flight. */
  running: boolean
  /** Live event log for UI debug (last 50 entries). */
  eventLog: BranchesEvent[]
  /** Active conflict awaiting user resolution; null if none. */
  activeConflict: ConflictPrompt | null
}

interface BranchesStore {
  byRepo: Record<string, BranchesPerRepo>
  busy: boolean
  hydrate: (repoPath: string) => Promise<void>
  addEdge: (args: { repoPath: string; parent: string; child: string }) => Promise<void>
  removeEdge: (args: { repoPath: string; parent: string; child: string }) => Promise<void>
  plan: (repoPath: string) => Promise<void>
  execute: (repoPath: string) => Promise<{ ok: boolean; error?: string }>
  resume: (repoPath: string) => Promise<{ ok: boolean; error?: string }>
  abort: (repoPath: string) => Promise<void>
  resolveConflict: (args: { repoPath: string; decision: 'continue' | 'abort' }) => Promise<void>
  suggestEdges: (repoPath: string) => Promise<void>
  configureRepo: (args: {
    repoPath: string
    enableRerere?: boolean
    installMergiraf?: boolean
  }) => Promise<void>
  /** Subscribe once at app boot — dispatches events to the right repo's slice. */
  startEventBridge: () => void
}

const empty = (view: BranchesView): BranchesPerRepo => ({
  view,
  lastPlan: null,
  running: false,
  eventLog: [],
  activeConflict: null,
})

export const useBranchesStore = create<BranchesStore>((set, get) => ({
  byRepo: {},
  busy: false,

  hydrate: async (repoPath) => {
    const api = window.api?.branches
    if (!api) return
    set({ busy: true })
    try {
      const view = await api.list(repoPath)
      set((s) => {
        const prior = s.byRepo[repoPath]
        // LIST returns suggestedEdges: [] (server keeps them ephemeral
        // because pairwise overlap detection is expensive to recompute
        // every hydrate). Preserve any client-side suggestions across
        // hydrates so a user mid-edit doesn't see them flicker out.
        const merged: BranchesView = prior
          ? { ...view, suggestedEdges: prior.view.suggestedEdges }
          : view
        return {
          byRepo: {
            ...s.byRepo,
            [repoPath]: prior ? { ...prior, view: merged } : empty(merged),
          },
        }
      })
    } finally {
      set({ busy: false })
    }
  },

  addEdge: async ({ repoPath, parent, child }) => {
    const api = window.api?.branches
    if (!api) return
    await api.addEdge({ repoPath, parent, child })
    await get().hydrate(repoPath)
  },

  removeEdge: async ({ repoPath, parent, child }) => {
    const api = window.api?.branches
    if (!api) return
    await api.removeEdge({ repoPath, parent, child })
    await get().hydrate(repoPath)
  },

  plan: async (repoPath) => {
    const api = window.api?.branches
    if (!api) return
    const result = await api.plan(repoPath)
    set((s) => {
      const slice = s.byRepo[repoPath]
      if (!slice) return s
      return { byRepo: { ...s.byRepo, [repoPath]: { ...slice, lastPlan: result } } }
    })
  },

  execute: async (repoPath) => {
    const api = window.api?.branches
    if (!api) return { ok: false, error: 'no api' }
    set((s) => {
      const slice = s.byRepo[repoPath]
      if (!slice) return s
      return { byRepo: { ...s.byRepo, [repoPath]: { ...slice, running: true } } }
    })
    try {
      const result = await api.execute(repoPath)
      await get().hydrate(repoPath)
      return result.ok
        ? { ok: true }
        : { ok: false, error: result.error }
    } finally {
      set((s) => {
        const slice = s.byRepo[repoPath]
        if (!slice) return s
        return { byRepo: { ...s.byRepo, [repoPath]: { ...slice, running: false } } }
      })
    }
  },

  resume: async (repoPath) => {
    const api = window.api?.branches
    if (!api) return { ok: false, error: 'no api' }
    set((s) => {
      const slice = s.byRepo[repoPath]
      if (!slice) return s
      return { byRepo: { ...s.byRepo, [repoPath]: { ...slice, running: true } } }
    })
    try {
      const result = await api.resume(repoPath)
      await get().hydrate(repoPath)
      return result.ok ? { ok: true } : { ok: false, error: result.error }
    } finally {
      set((s) => {
        const slice = s.byRepo[repoPath]
        if (!slice) return s
        return { byRepo: { ...s.byRepo, [repoPath]: { ...slice, running: false } } }
      })
    }
  },

  abort: async (repoPath) => {
    const api = window.api?.branches
    if (!api) return
    await api.abort(repoPath)
    await get().hydrate(repoPath)
  },

  resolveConflict: async ({ repoPath, decision }) => {
    const api = window.api?.branches
    if (!api) return
    await api.resolveConflict({ repoPath, decision })
    set((s) => {
      const slice = s.byRepo[repoPath]
      if (!slice) return s
      return {
        byRepo: { ...s.byRepo, [repoPath]: { ...slice, activeConflict: null } },
      }
    })
  },

  suggestEdges: async (repoPath) => {
    const api = window.api?.branches
    if (!api) return
    const { suggestedEdges } = await api.suggestEdges(repoPath)
    set((s) => {
      const slice = s.byRepo[repoPath]
      if (!slice) return s
      return {
        byRepo: {
          ...s.byRepo,
          [repoPath]: {
            ...slice,
            view: { ...slice.view, suggestedEdges: suggestedEdges as SuggestedEdgeWire[] },
          },
        },
      }
    })
  },

  configureRepo: async (args) => {
    const api = window.api?.branches
    if (!api) return
    await api.configureRepo(args)
    await get().hydrate(args.repoPath)
  },

  startEventBridge: () => {
    const api = window.api?.branches
    if (!api) return
    // Idempotent — re-mounting BranchesScreen (e.g. project switch)
    // calls this from useEffect. Guard so we don't stack listeners.
    if (eventBridgeStarted) return
    eventBridgeStarted = true
    api.onEvent((event) => {
      // Events don't carry `repoPath` — we apply them to whichever
      // repo currently has `running: true`. There's only ever one
      // active plan at a time (planner serializes execute/resume).
      set((s) => {
        const entries = Object.entries(s.byRepo)
        const activeEntry = entries.find(([, slice]) => slice.running)
        if (!activeEntry) return s
        const [repoPath, slice] = activeEntry
        const nextLog = [...slice.eventLog, event].slice(-50)
        let activeConflict = slice.activeConflict
        if (event.kind === 'conflict.opened') {
          activeConflict = {
            index: event.index,
            branch: event.branch,
            conflictFiles: event.conflictFiles,
          }
        } else if (PLAN_TERMINAL_KINDS.has(event.kind)) {
          activeConflict = null
        }
        return {
          byRepo: {
            ...s.byRepo,
            [repoPath]: { ...slice, eventLog: nextLog, activeConflict },
          },
        }
      })
    })
  },
}))
