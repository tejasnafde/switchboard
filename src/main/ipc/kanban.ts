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
  setKanbanWorktree,
  getKanbanCard,
  listInUseWorktreePaths,
} from '../db/database'
import {
  createWorktree,
  removeWorktree,
  listWorktrees,
  findStaleWorktrees,
  rmWorktreeDir,
  worktreeRootFor,
} from '../worktree'
import type { KanbanCardCreate, KanbanCardUpdate } from '@shared/kanban'

const log = createMainLogger('kanban')

export function registerKanbanHandlers(host: BackendHost): void {
  host.handle(KanbanChannels.LIST, async (projectPath: string) => {
    return listKanbanCards(projectPath)
  })

  host.handle(KanbanChannels.CREATE, async (input: KanbanCardCreate) => {
    const id = `card_${randomUUID()}`
    const card = createKanbanCard(id, input)
    log.info(`created card ${id} (${input.title}) in ${input.projectPath}`)

    if (input.withWorktree) {
      try {
        const { path, branch } = await createWorktree(input.projectPath, id, input.title)
        const updated = setKanbanWorktree(id, path, branch)
        return updated ?? card
      } catch (err) {
        // Card already created - surface the worktree failure but keep
        // the row, so the user can retry / decide to drop the worktree
        // requirement instead of losing their description.
        log.warn(`worktree creation failed for ${id}: ${err instanceof Error ? err.message : String(err)}`)
        throw err
      }
    }
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
        await removeWorktree(card.projectPath, card.worktreePath, {
          force: opts.force,
          deleteBranch: card.worktreeBranch,
        })
      } catch (err) {
        log.warn(`worktree removal failed during card delete (${id}): ${err instanceof Error ? err.message : String(err)}`)
        throw err
      }
    }
    deleteKanbanCard(id)
    log.info(`deleted card ${id}`)
  })

  host.handle(KanbanChannels.CREATE_WORKTREE, async (id: string) => {
    const card = getKanbanCard(id)
    if (!card) throw new Error(`Unknown card: ${id}`)
    if (card.worktreePath) return card // idempotent
    const { path, branch } = await createWorktree(card.projectPath, id, card.title)
    return setKanbanWorktree(id, path, branch)
  })

  host.handle(KanbanChannels.REMOVE_WORKTREE, async (id: string, opts?: { force?: boolean }) => {
    const card = getKanbanCard(id)
    if (!card?.worktreePath) return card
    await removeWorktree(card.projectPath, card.worktreePath, {
      force: opts?.force,
      deleteBranch: card.worktreeBranch,
    })
    return setKanbanWorktree(id, null, null)
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

  /**
   * Stale worktree removal - operates on a path, not a card id. Guards against
   * arbitrary-path removal by requiring the target to appear in `git worktree list`
   * for this repo; falls back to a `.switchboard/worktrees/` prefix check for dirs
   * git has already pruned but are still on disk. Falls through to `rmWorktreeDir`
   * if `git worktree remove` fails (e.g. the directory is already gone but git's
   * metadata isn't, or the worktree is corrupt).
   */
  host.handle(
    KanbanChannels.REMOVE_STALE_WORKTREE,
    async (projectPath: string, worktreePath: string, opts?: { force?: boolean }) => {
      const resolvedTarget = resolve(worktreePath)
      const knownWorktrees = await listWorktrees(projectPath)
      const isRegistered = knownWorktrees.some((wt) => wt.path === resolvedTarget)

      if (!isRegistered) {
        // Fallback for dirs git has already pruned from its registry.
        const root = worktreeRootFor(projectPath)
        if (!resolvedTarget.startsWith(root)) {
          throw new Error(`Refusing to remove worktree not registered with this repo: ${worktreePath}`)
        }
      }

      try {
        await removeWorktree(projectPath, worktreePath, { force: opts?.force })
      } catch (err) {
        log.warn(`stale removeWorktree failed, falling back to rm: ${err instanceof Error ? err.message : String(err)}`)
        await rmWorktreeDir(worktreePath)
      }
      log.info(`removed stale worktree: ${worktreePath}`)
    },
  )

  log.info('IPC handlers registered')
}
