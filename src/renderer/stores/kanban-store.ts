/**
 * Kanban store — cards keyed by project path.
 *
 * Source of truth lives in main (SQLite). This store is a renderer
 * cache: hydrate on project switch, mutate via IPC, then re-hydrate.
 * We deliberately don't try to do optimistic updates yet — kanban
 * mutations are infrequent and human-paced; the round-trip cost
 * (~5ms) is invisible and the simpler model is easier to reason about
 * when worktree-creation failures happen mid-mutation.
 */

import { create } from 'zustand'
import type { KanbanCard, KanbanCardCreate, KanbanCardUpdate, KanbanStatus } from '@shared/kanban'

interface KanbanStore {
  /** projectPath → cards */
  byProject: Record<string, KanbanCard[]>
  /** Set while a hydrate / create / update is inflight, so the UI can dim or block actions. */
  busy: boolean
  hydrate: (projectPath: string) => Promise<void>
  create: (input: KanbanCardCreate) => Promise<KanbanCard | null>
  update: (id: string, patch: KanbanCardUpdate) => Promise<void>
  move: (id: string, status: KanbanStatus) => Promise<void>
  remove: (id: string, opts?: { removeWorktree?: boolean; force?: boolean }) => Promise<void>
  attachWorktree: (id: string) => Promise<void>
  detachWorktree: (id: string, opts?: { force?: boolean }) => Promise<void>
}

export const useKanbanStore = create<KanbanStore>((set, get) => ({
  byProject: {},
  busy: false,

  hydrate: async (projectPath) => {
    const api = window.api?.kanban
    if (!api) return
    set({ busy: true })
    try {
      const cards = await api.list(projectPath)
      set((s) => ({ byProject: { ...s.byProject, [projectPath]: cards } }))
    } finally {
      set({ busy: false })
    }
  },

  create: async (input) => {
    const api = window.api?.kanban
    if (!api) return null
    set({ busy: true })
    try {
      const card = await api.create(input)
      set((s) => {
        const prev = s.byProject[input.projectPath] ?? []
        return { byProject: { ...s.byProject, [input.projectPath]: [card, ...prev] } }
      })
      return card
    } finally {
      set({ busy: false })
    }
  },

  update: async (id, patch) => {
    const api = window.api?.kanban
    if (!api) return
    const updated = await api.update(id, patch)
    if (!updated) return
    set((s) => {
      const list = s.byProject[updated.projectPath] ?? []
      return {
        byProject: {
          ...s.byProject,
          [updated.projectPath]: list.map((c) => (c.id === id ? updated : c)),
        },
      }
    })
  },

  move: async (id, status) => {
    await get().update(id, { status })
  },

  remove: async (id, opts) => {
    const api = window.api?.kanban
    if (!api) return
    // Find the project path before deletion so we can patch the right slice.
    let projectPath: string | null = null
    for (const [path, list] of Object.entries(get().byProject)) {
      if (list.some((c) => c.id === id)) { projectPath = path; break }
    }
    await api.delete(id, opts)
    if (projectPath) {
      set((s) => ({
        byProject: {
          ...s.byProject,
          [projectPath!]: (s.byProject[projectPath!] ?? []).filter((c) => c.id !== id),
        },
      }))
    }
  },

  attachWorktree: async (id) => {
    const api = window.api?.kanban
    if (!api) return
    const updated = await api.createWorktree(id)
    if (!updated) return
    set((s) => {
      const list = s.byProject[updated.projectPath] ?? []
      return {
        byProject: {
          ...s.byProject,
          [updated.projectPath]: list.map((c) => (c.id === id ? updated : c)),
        },
      }
    })
  },

  detachWorktree: async (id, opts) => {
    const api = window.api?.kanban
    if (!api) return
    const updated = await api.removeWorktree(id, opts)
    if (!updated) return
    set((s) => {
      const list = s.byProject[updated.projectPath] ?? []
      return {
        byProject: {
          ...s.byProject,
          [updated.projectPath]: list.map((c) => (c.id === id ? updated : c)),
        },
      }
    })
  },
}))
