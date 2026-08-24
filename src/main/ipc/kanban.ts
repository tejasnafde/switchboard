/**
 * Kanban IPC handlers - card CRUD + per-card worktree lifecycle.
 *
 * Cards live in SQLite (`kanban_cards`); worktrees live on disk under
 * `<projectPath>/.switchboard/worktrees/`. The two are linked by the
 * `worktree_path` column on the card row. Creating a worktree is an
 * explicit second step (not part of card creation) so the user can opt
 * in per card and so failure modes (not-a-git-repo, branch already
 * exists) surface separately from the row insert.
 */

import type { BackendHost } from '../backend/host'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { KanbanChannels } from '@shared/ipc-channels'
import { createMainLogger } from '../logger'
import {
  createKanbanCard,
  listKanbanCards,
  updateKanbanCard,
  deleteKanbanCard,
  getKanbanCard,
  getKanbanWorktreeCreationKey,
  listInUseWorktreePaths,
} from '../db/database'
import {
  removeWorktree,
  listWorktrees,
  findStaleWorktrees,
} from '../worktree'
import type { KanbanCardCreate, KanbanCardUpdate } from '@shared/kanban'
import type { KanbanWorktreeCreationIntent } from '@shared/kanban'
import type {
  GetWorktreeCreationRequest,
  WorktreeCreationActionRequest,
  WorktreeCreationRequest,
  WorktreeCreationSnapshot,
} from '@shared/worktree-creation'
import {
  buildExistingCardWorktreeRequest,
  buildNewCardWorktreeRequest,
} from '../kanban/worktree-requests'

const log = createMainLogger('kanban')

export interface KanbanHandlerDependencies {
  createWorktreeTransaction?: (request: WorktreeCreationRequest) => Promise<WorktreeCreationSnapshot>
  getWorktreeCreation?: (request: GetWorktreeCreationRequest) => Promise<WorktreeCreationSnapshot>
  actOnWorktreeCreation?: (request: WorktreeCreationActionRequest) => Promise<WorktreeCreationSnapshot>
  createCardId?: () => string
  createCreationId?: () => string
  now?: () => number
}

export function registerKanbanHandlers(
  host: BackendHost,
  deps: KanbanHandlerDependencies = {},
): void {
  const createCardId = deps.createCardId ?? (() => `card_${randomUUID()}`)
  const createCreationId = deps.createCreationId ?? randomUUID
  const now = deps.now ?? Date.now

  const removeCardWorktree = async (id: string) => {
    const card = getKanbanCard(id)
    if (!card?.worktreePath) return card
    const creationKey = getKanbanWorktreeCreationKey(id)
    if (creationKey) {
      if (!deps.getWorktreeCreation || !deps.actOnWorktreeCreation) {
        throw new Error('Canonical worktree cleanup is unavailable; no files were removed.')
      }
      const snapshot = await deps.getWorktreeCreation(creationKey)
      const removed = await deps.actOnWorktreeCreation({
        ...creationKey,
        expectedRevision: snapshot.revision,
        action: 'remove',
      })
      if (removed.cleanupDisposition !== 'removed') {
        throw new Error('The worktree could not be removed safely. Commit or remove local changes, then retry.')
      }
      return getKanbanCard(id)
    }
    throw new Error(
      'Canonical worktree identity is unavailable. Restart Switchboard to run the legacy catalog migration; no files were removed.',
    )
  }

  const attachDurableCreation = async (card: ReturnType<typeof getKanbanCard>) => {
    if (!card || !deps.getWorktreeCreation) return card
    const key = getKanbanWorktreeCreationKey(card.id)
    if (!key) return card
    try {
      return { ...card, worktreeCreation: await deps.getWorktreeCreation(key) }
    } catch {
      return card
    }
  }

  host.handle(KanbanChannels.LIST, async (projectPath: string) => {
    return Promise.all(listKanbanCards(projectPath).map(attachDurableCreation))
  })

  host.handle(KanbanChannels.CREATE, async (input: KanbanCardCreate) => {
    const id = input.worktreeCreation?.cardId ?? createCardId()
    if (input.withWorktree) {
      if (!deps.createWorktreeTransaction) {
        throw new Error('Worktree creation transaction is unavailable; the card was not created.')
      }
      const request = buildNewCardWorktreeRequest({
        cardId: id,
        card: input,
        createId: createCreationId,
        now,
      })
      const worktreeCreation = await deps.createWorktreeTransaction(request)
      const card = getKanbanCard(id)
      if (!card) throw new Error(`Kanban worktree creation ${request.creationId} did not preserve its card.`)
      log.info(`created card ${id} through worktree transaction ${request.creationId}`)
      return { ...card, worktreeCreation }
    }

    const card = createKanbanCard(id, input)
    log.info(`created card ${id} (${input.title}) in ${input.projectPath}`)

    return card
  })

  host.handle(KanbanChannels.UPDATE, async (id: string, patch: KanbanCardUpdate) => {
    // Log conversation-link transitions specifically - they're the
    // signal that a card is being launched, and the only way to trace
    // launches end-to-end across the renderer/main boundary.
    if (Object.prototype.hasOwnProperty.call(patch, 'conversationId')) {
      log.info(`linked card ${id} → conversation ${patch.conversationId ?? '(cleared)'}`)
    }
    if (patch.status) {
      log.info(`card ${id} status → ${patch.status}`)
    }
    return updateKanbanCard(id, patch)
  })

  host.handle(KanbanChannels.DELETE, async (id: string, opts?: { removeWorktree?: boolean; force?: boolean }) => {
    const card = getKanbanCard(id)
    if (!card) return
    if (opts?.removeWorktree && card.worktreePath) {
      try {
        await removeCardWorktree(id)
      } catch (err) {
        log.warn(`worktree removal failed during card delete (${id}): ${err instanceof Error ? err.message : String(err)}`)
        throw err
      }
    }
    deleteKanbanCard(id)
    log.info(`deleted card ${id}`)
  })

  host.handle(KanbanChannels.CREATE_WORKTREE, async (
    id: string,
    intent?: KanbanWorktreeCreationIntent,
  ) => {
    const card = getKanbanCard(id)
    if (!card) throw new Error(`Unknown card: ${id}`)
    if (card.worktreePath) return card // idempotent
    if (deps.createWorktreeTransaction) {
      const request = buildExistingCardWorktreeRequest({
        card,
        intent,
        createId: createCreationId,
        now,
      })
      const worktreeCreation = await deps.createWorktreeTransaction(request)
      const updated = getKanbanCard(id)
      if (!updated) throw new Error(`Kanban card ${id} disappeared during worktree creation.`)
      return { ...updated, worktreeCreation }
    }
    throw new Error('Worktree creation transaction is unavailable; the card remains in the backlog.')
  })

  host.handle(KanbanChannels.REMOVE_WORKTREE, async (id: string, _opts?: { force?: boolean }) => {
    return removeCardWorktree(id)
  })

  host.handle(KanbanChannels.LIST_WORKTREES, async (projectPath: string) => {
    const inUse = listInUseWorktreePaths(projectPath)
    const all = await listWorktrees(projectPath)
    return all.map((wt) => ({ ...wt, inUse: inUse.has(wt.path) }))
  })

  host.handle(KanbanChannels.LIST_STALE_WORKTREES, async (projectPath: string) => {
    const inUse = listInUseWorktreePaths(projectPath)
    return findStaleWorktrees(projectPath, inUse)
  })

  host.handle(
    KanbanChannels.REMOVE_STALE_WORKTREE,
    async (projectPath: string, worktreePath: string, opts?: { force?: boolean }) => {
      const resolvedTarget = resolve(worktreePath)
      const knownWorktrees = await listWorktrees(projectPath)
      const isRegistered = knownWorktrees.some((wt) => wt.path === resolvedTarget)
      if (!isRegistered) {
        throw new Error(`Refusing to remove worktree not registered with this repo: ${worktreePath}`)
      }
      const inUse = listInUseWorktreePaths(projectPath)
      if (inUse.has(resolvedTarget)) {
        throw new Error('Refusing to remove a worktree that is owned by an active conversation or card.')
      }
      await removeWorktree(projectPath, resolvedTarget, { force: opts?.force })
      log.info(`removed stale worktree: ${worktreePath}`)
    },
  )

  log.info('IPC handlers registered')
}
