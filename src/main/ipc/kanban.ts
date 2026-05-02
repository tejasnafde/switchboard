/**
 * Kanban IPC handlers — card CRUD + per-card worktree lifecycle.
 *
 * Cards live in SQLite (`kanban_cards`); worktrees live on disk under
 * `<projectPath>/.switchboard/worktrees/`. The two are linked by the
 * `worktree_path` column on the card row. Creating a worktree is an
 * explicit second step (not part of card creation) so the user can opt
 * in per card and so failure modes (not-a-git-repo, branch already
 * exists) surface separately from the row insert.
 */

import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
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

export function registerKanbanHandlers(): void {
  for (const ch of Object.values(KanbanChannels)) {
    try { ipcMain.removeHandler(ch) } catch { /* not registered yet */ }
  }

  ipcMain.handle(KanbanChannels.LIST, async (_e, projectPath: string) => {
    return listKanbanCards(projectPath)
  })

  ipcMain.handle(KanbanChannels.CREATE, async (_e, input: KanbanCardCreate) => {
    const id = `card_${randomUUID()}`
    const card = createKanbanCard(id, input)
    log.info(`created card ${id} (${input.title}) in ${input.projectPath}`)

    if (input.withWorktree) {
      try {
        const { path, branch } = await createWorktree(input.projectPath, id, input.title)
        const updated = setKanbanWorktree(id, path, branch)
        return updated ?? card
      } catch (err) {
        // Card already created — surface the worktree failure but keep
        // the row, so the user can retry / decide to drop the worktree
        // requirement instead of losing their description.
        log.warn(`worktree creation failed for ${id}: ${err instanceof Error ? err.message : String(err)}`)
        throw err
      }
    }
    return card
  })

  ipcMain.handle(KanbanChannels.UPDATE, async (_e, id: string, patch: KanbanCardUpdate) => {
    return updateKanbanCard(id, patch)
  })

  ipcMain.handle(KanbanChannels.DELETE, async (_e, id: string, opts?: { removeWorktree?: boolean; force?: boolean }) => {
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

  ipcMain.handle(KanbanChannels.CREATE_WORKTREE, async (_e, id: string) => {
    const card = getKanbanCard(id)
    if (!card) throw new Error(`Unknown card: ${id}`)
    if (card.worktreePath) return card // idempotent
    const { path, branch } = await createWorktree(card.projectPath, id, card.title)
    return setKanbanWorktree(id, path, branch)
  })

  ipcMain.handle(KanbanChannels.REMOVE_WORKTREE, async (_e, id: string, opts?: { force?: boolean }) => {
    const card = getKanbanCard(id)
    if (!card?.worktreePath) return card
    await removeWorktree(card.projectPath, card.worktreePath, {
      force: opts?.force,
      deleteBranch: card.worktreeBranch,
    })
    return setKanbanWorktree(id, null, null)
  })

  ipcMain.handle(KanbanChannels.LIST_WORKTREES, async (_e, projectPath: string) => {
    const inUse = listInUseWorktreePaths(projectPath)
    const all = await listWorktrees(projectPath)
    return all.map((wt) => ({ ...wt, inUse: inUse.has(wt.path) }))
  })

  ipcMain.handle(KanbanChannels.LIST_STALE_WORKTREES, async (_e, projectPath: string) => {
    const inUse = listInUseWorktreePaths(projectPath)
    return findStaleWorktrees(projectPath, inUse)
  })

  /**
   * Stale worktree removal — operates on a path, not a card id. Refuses to
   * touch anything outside the project's managed `.switchboard/worktrees/`
   * root so a malformed renderer call can't `rm -rf` arbitrary directories.
   * Falls through to `rmWorktreeDir` if `git worktree remove` fails to
   * clean up (e.g. the directory is already gone but git's metadata isn't,
   * or the worktree is corrupt and force-remove still refuses).
   */
  ipcMain.handle(
    KanbanChannels.REMOVE_STALE_WORKTREE,
    async (_e, projectPath: string, worktreePath: string, opts?: { force?: boolean }) => {
      const root = worktreeRootFor(projectPath)
      if (!worktreePath.startsWith(root)) {
        throw new Error(`Refusing to remove worktree outside ${root}: ${worktreePath}`)
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
