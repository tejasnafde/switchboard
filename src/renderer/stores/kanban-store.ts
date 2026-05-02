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
  /** Lookup used by the AskUserQuestion → needs_input auto-promote in ChatPanel. */
  findByConversationId: (conversationId: string) => KanbanCard | undefined
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
    // Optimistic so drag-drops feel instant — the local IPC is the
    // only writer, so divergence is negligible and the next hydrate
    // reconciles anyway.
    set((s) => {
      const next: Record<string, KanbanCard[]> = { ...s.byProject }
      for (const [path, list] of Object.entries(s.byProject)) {
        const idx = list.findIndex((c) => c.id === id)
        if (idx === -1) continue
        const patched = { ...list[idx], status, updatedAt: Date.now() }
        next[path] = [...list.slice(0, idx), patched, ...list.slice(idx + 1)]
        break
      }
      return { byProject: next }
    })
    await get().update(id, { status })
  },

  findByConversationId: (conversationId) => {
    for (const list of Object.values(get().byProject)) {
      const hit = list.find((c) => c.conversationId === conversationId)
      if (hit) return hit
    }
    return undefined
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
