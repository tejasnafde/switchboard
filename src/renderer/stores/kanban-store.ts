/**
 * Kanban store - cards keyed by project path.
 *
 * Source of truth lives in main (SQLite). This store is a renderer
 * cache: hydrate on project switch, mutate via IPC, then re-hydrate.
 * We deliberately don't try to do optimistic updates yet - kanban
 * mutations are infrequent and human-paced; the round-trip cost
 * (~5ms) is invisible and the simpler model is easier to reason about
 * when worktree-creation failures happen mid-mutation.
 */

import { create } from 'zustand'
import type { KanbanCard, KanbanCardCreate, KanbanCardUpdate, KanbanStatus } from '@shared/kanban'
import type {
  WorktreeCreationRecoveryAction,
  WorktreeCreationProgressEvent,
  WorktreeCreationSnapshot,
} from '@shared/worktree-creation'

function withWorktreeSnapshot(
  card: KanbanCard,
  snapshot: WorktreeCreationSnapshot,
): KanbanCard {
  return {
    ...card,
    worktreePath: snapshot.worktreePath ?? card.worktreePath,
    worktreeBranch: snapshot.branch ?? card.worktreeBranch,
    worktreeCreation: snapshot,
  }
}

interface KanbanStore {
  /** projectPath → cards */
  byProject: Record<string, KanbanCard[]>
  /** Set while a hydrate / create / update is inflight, so the UI can dim or block actions. */
  busy: boolean
  /** Card ids with a `launchCardChat` in flight. Shared between KanbanView
   *  and CardModal so a double-fire from either surface is blocked. */
  launchingCardIds: ReadonlySet<string>
  /** Take the per-card launch lock. Returns false when a launch is already
   *  in flight - a second launch would mint a new session id and overwrite
   *  card.conversationId, orphaning the first provider process. */
  beginCardLaunch: (id: string) => boolean
  endCardLaunch: (id: string) => void
  hydrate: (projectPath: string) => Promise<void>
  create: (input: KanbanCardCreate) => Promise<KanbanCard | null>
  update: (id: string, patch: KanbanCardUpdate) => Promise<void>
  move: (id: string, status: KanbanStatus) => Promise<void>
  /** Lookup used by the AskUserQuestion → needs_input auto-promote in ChatPanel. */
  findByConversationId: (conversationId: string) => KanbanCard | undefined
  remove: (id: string, opts?: { removeWorktree?: boolean; force?: boolean }) => Promise<void>
  attachWorktree: (id: string) => Promise<KanbanCard | null>
  actOnWorktree: (id: string, action: WorktreeCreationRecoveryAction) => Promise<KanbanCard | null>
  retryWorktree: (id: string) => Promise<KanbanCard | null>
  reconcileWorktreeProgress: (event: WorktreeCreationProgressEvent) => Promise<void>
  detachWorktree: (id: string, opts?: { force?: boolean }) => Promise<void>
}

export const useKanbanStore = create<KanbanStore>((set, get) => ({
  byProject: {},
  busy: false,
  launchingCardIds: new Set<string>(),

  beginCardLaunch: (id) => {
    if (get().launchingCardIds.has(id)) return false
    set((s) => ({ launchingCardIds: new Set(s.launchingCardIds).add(id) }))
    return true
  },

  endCardLaunch: (id) => {
    set((s) => {
      const next = new Set(s.launchingCardIds)
      next.delete(id)
      return { launchingCardIds: next }
    })
  },

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
      const submitted = input.withWorktree
        ? {
            ...input,
            worktreeCreation: {
              ...input.worktreeCreation,
              cardId: input.worktreeCreation?.cardId ?? `card_${crypto.randomUUID()}`,
              creationId: input.worktreeCreation?.creationId ?? crypto.randomUUID(),
              machineId: input.worktreeCreation?.machineId ?? 'local',
              requestedAt: input.worktreeCreation?.requestedAt ?? Date.now(),
            },
          }
        : input
      const intent = submitted.worktreeCreation
      if (submitted.withWorktree && intent?.cardId && intent.creationId) {
        const createdAt = Date.now()
        const optimistic: KanbanCard = {
          id: intent.cardId,
          projectPath: input.projectPath,
          title: input.title,
          description: input.description ?? '',
          tags: input.tags ?? [],
          status: input.worktreeCreation?.initialAgent ? 'in_progress' : input.status ?? 'backlog',
          costCapUsd: input.costCapUsd ?? null,
          costUsedUsd: null,
          runtimeMode: input.runtimeMode ?? 'accept-edits',
          conversationId: null,
          worktreePath: null,
          worktreeBranch: null,
          createdAt,
          updatedAt: createdAt,
          completedAt: null,
          worktreeCreation: {
            creationId: intent.creationId,
            revision: 0,
            phase: 'pending',
            status: 'pending',
            projectPath: input.projectPath,
            baseRef: intent.baseRef ?? 'HEAD',
            owner: { kind: 'kanban-card', cardId: intent.cardId, create: {
              title: input.title,
              description: input.description ?? '',
              tags: input.tags ?? [],
              status: input.worktreeCreation?.initialAgent ? 'in_progress' : input.status ?? 'backlog',
              runtimeMode: input.runtimeMode ?? 'accept-edits',
              costCapUsd: input.costCapUsd ?? null,
            } },
            purpose: 'kanban',
            provenance: {
              surface: 'desktop',
              machineId: intent.machineId ?? 'local',
              requestedAt: intent.requestedAt ?? createdAt,
            },
            warnings: [],
            recoveryActions: ['cancel'],
            updatedAt: createdAt,
          },
        }
        set((state) => ({
          byProject: {
            ...state.byProject,
            [input.projectPath]: [optimistic, ...(state.byProject[input.projectPath] ?? [])],
          },
        }))
      }
      let card: KanbanCard
      try {
        card = await api.create(submitted)
      } catch (error) {
        if (intent?.cardId) {
          set((state) => ({
            byProject: {
              ...state.byProject,
              [input.projectPath]: (state.byProject[input.projectPath] ?? [])
                .filter((candidate) => candidate.id !== intent.cardId),
            },
          }))
        }
        throw error
      }
      set((s) => {
        const prev = (s.byProject[input.projectPath] ?? []).filter((candidate) => candidate.id !== card.id)
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
    // Optimistic so drag-drops feel instant - the local IPC is the
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
    if (!api) return null
    const updated = await api.createWorktree(id, {
      creationId: crypto.randomUUID(),
      machineId: 'local',
      requestedAt: Date.now(),
      initialAgent: (() => {
        let card: KanbanCard | undefined
        for (const cards of Object.values(get().byProject)) {
          card = cards.find((candidate) => candidate.id === id)
          if (card) break
        }
        if (!card) return undefined
        const prompt = [card.title.trim(), card.description.trim()].filter(Boolean).join('\n\n')
        return {
          provider: 'claude-code' as const,
          runtimeMode: card.runtimeMode,
          prompt: prompt || 'Start working on this card.',
        }
      })(),
    })
    if (!updated) return null
    set((s) => {
      const list = s.byProject[updated.projectPath] ?? []
      return {
        byProject: {
          ...s.byProject,
          [updated.projectPath]: list.map((c) => (c.id === id ? updated : c)),
        },
      }
    })
    return updated
  },

  actOnWorktree: async (id, action) => {
    let card: KanbanCard | undefined
    for (const cards of Object.values(get().byProject)) {
      card = cards.find((candidate) => candidate.id === id)
      if (card) break
    }
    const snapshot = card?.worktreeCreation
    if (!card || !snapshot || !snapshot.recoveryActions.includes(action)) return card ?? null
    const updatedSnapshot = await window.api.worktreeCreation.act({
      creationId: snapshot.creationId,
      machineId: snapshot.provenance.machineId,
      expectedRevision: snapshot.revision,
      action,
    })
    const canonicalCards = await window.api.kanban?.list?.(card.projectPath) ?? [card]
    const canonicalCard = canonicalCards.find((candidate) => candidate.id === id) ?? card
    const updated = withWorktreeSnapshot(canonicalCard, updatedSnapshot)
    set((state) => ({
      byProject: {
        ...state.byProject,
        [card.projectPath]: (state.byProject[card.projectPath] ?? [])
          .map((candidate) => candidate.id === id ? updated : candidate),
      },
    }))
    return updated
  },

  retryWorktree: async (id) => get().actOnWorktree(id, 'retry'),

  reconcileWorktreeProgress: async (event) => {
    let card: KanbanCard | undefined
    for (const cards of Object.values(get().byProject)) {
      card = cards.find((candidate) => candidate.worktreeCreation?.creationId === event.creationId)
      if (card) break
    }
    const current = card?.worktreeCreation
    if (!card || !current || event.revision < current.revision) return
    const snapshot = await window.api.worktreeCreation.get({
      creationId: event.creationId,
      machineId: current.provenance.machineId,
    })
    set((state) => ({
      byProject: {
        ...state.byProject,
        [card.projectPath]: (state.byProject[card.projectPath] ?? []).map((candidate) => {
          if (candidate.id !== card.id) return candidate
          if ((candidate.worktreeCreation?.revision ?? -1) > snapshot.revision) return candidate
          return withWorktreeSnapshot(candidate, snapshot)
        }),
      },
    }))
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
