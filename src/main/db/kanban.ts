import { createMainLogger as createLogger } from '../logger'
import { parseErrorKind } from './parse-error'
import type { KanbanCard, KanbanCardCreate, KanbanCardUpdate, KanbanStatus } from '@shared/kanban'
import { KANBAN_DEFAULT_RUNTIME_MODE } from '@shared/kanban'
import { applyKanbanArchiveSideEffect } from '@shared/kanbanArchive'
import type { RuntimeMode } from '@shared/provider-events'
import { isRuntimeMode } from '@shared/session-defaults'
import { getKanbanWorktreeCreationKey as getKanbanWorktreeCreationKeyFromDb, listOwnedWorktreePaths } from './worktree-creation'
import { getDb } from './database'
import { archiveConversation, unarchiveConversation } from './conversations'

const log = createLogger('db')

// ─── Kanban CRUD ─────────────────────────────────────────────────

interface KanbanRow {
  id: string
  project_path: string
  title: string
  description: string
  tags: string
  status: string
  cost_cap_usd: number | null
  cost_used_usd: number | null
  runtime_mode: string | null
  conversation_id: string | null
  worktree_path: string | null
  worktree_branch: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
}

/** Coerce a stored runtime-mode string back into the typed union; legacy/unknown → default. */
function normalizeRuntimeMode(raw: string | null | undefined): RuntimeMode {
  return isRuntimeMode(raw) ? raw : KANBAN_DEFAULT_RUNTIME_MODE
}

function rowToCard(r: KanbanRow): KanbanCard {
  let tags: string[] = []
  try {
    const parsed = JSON.parse(r.tags)
    if (Array.isArray(parsed)) tags = parsed.map(String)
  } catch (err) {
    log.debug('kanban card tags JSON malformed - showing as empty', { cardId: r.id, error: parseErrorKind(err) })
  }
  return {
    id: r.id,
    projectPath: r.project_path,
    title: r.title,
    description: r.description,
    tags,
    status: r.status as KanbanStatus,
    costCapUsd: r.cost_cap_usd,
    costUsedUsd: r.cost_used_usd,
    runtimeMode: normalizeRuntimeMode(r.runtime_mode),
    conversationId: r.conversation_id,
    worktreePath: r.worktree_path,
    worktreeBranch: r.worktree_branch,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  }
}

export function createKanbanCard(id: string, input: KanbanCardCreate): KanbanCard {
  const tagsJson = JSON.stringify(input.tags ?? [])
  const runtimeMode = input.runtimeMode ?? KANBAN_DEFAULT_RUNTIME_MODE
  getDb().prepare(`
    INSERT INTO kanban_cards (id, project_path, title, description, tags, status, cost_cap_usd, runtime_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.projectPath, input.title, input.description ?? '', tagsJson, input.status ?? 'backlog', input.costCapUsd ?? null, runtimeMode)
  return getKanbanCard(id)!
}

export function getKanbanCard(id: string): KanbanCard | null {
  const row = getDb().prepare('SELECT * FROM kanban_cards WHERE id = ?').get(id) as KanbanRow | undefined
  return row ? rowToCard(row) : null
}

export function listKanbanCards(projectPath: string): KanbanCard[] {
  const rows = getDb().prepare(
    'SELECT * FROM kanban_cards WHERE project_path = ? ORDER BY status, updated_at DESC'
  ).all(projectPath) as KanbanRow[]
  return rows.map(rowToCard)
}

export function updateKanbanCard(id: string, patch: KanbanCardUpdate): KanbanCard | null {
  const existing = getKanbanCard(id)
  if (!existing) return null
  const next = { ...existing, ...patch }
  const completedAt = patch.status === 'done' && existing.status !== 'done'
    ? Date.now()
    : patch.status && patch.status !== 'done' ? null : existing.completedAt
  // Card row + archive side effect run atomically so a Done transition
  // can't leave the row updated while the conversation archive write
  // fails (or vice versa).
  getDb().transaction(() => {
    getDb().prepare(`
      UPDATE kanban_cards SET
        title = ?, description = ?, tags = ?, status = ?,
        cost_cap_usd = ?, cost_used_usd = ?, conversation_id = ?,
        updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(
      next.title, next.description, JSON.stringify(next.tags), next.status,
      next.costCapUsd, next.costUsedUsd, next.conversationId,
      Date.now(), completedAt, id,
    )
    // "Done" column doubles as an archive trigger: moving a linked card
    // into Done archives its conversation; moving back out unarchives.
    applyKanbanArchiveSideEffect(
      { status: existing.status, conversationId: existing.conversationId },
      { status: patch.status },
      { archive: archiveConversation, unarchive: unarchiveConversation },
    )
  })()
  return getKanbanCard(id)
}

export function setKanbanWorktree(id: string, path: string | null, branch: string | null): KanbanCard | null {
  getDb().prepare(`
    UPDATE kanban_cards SET worktree_path = ?, worktree_branch = ?, updated_at = ? WHERE id = ?
  `).run(path, branch, Date.now(), id)
  return getKanbanCard(id)
}

export function deleteKanbanCard(id: string): void {
  getDb().prepare('DELETE FROM kanban_cards WHERE id = ?').run(id)
}

export function listInUseWorktreePaths(projectPath: string): Set<string> {
  return listOwnedWorktreePaths(getDb(), projectPath)
}

export function getKanbanWorktreeCreationKey(id: string): { machineId: string; creationId: string } | null {
  return getKanbanWorktreeCreationKeyFromDb(getDb(), id)
}
