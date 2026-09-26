import type Database from 'better-sqlite3'
import type { WorktreeChatLink } from '@shared/worktree-manager'
import { getDb } from './database'

/**
 * The chat (else the kanban card) each worktree path of a project runs in,
 * for the worktree manager's Chat column. A live chat wins over an archived
 * one, then the most recently updated.
 */
export function listWorktreeChatLinks(projectPath: string, db: Database.Database = getDb()): Map<string, WorktreeChatLink> {
  const links = new Map<string, WorktreeChatLink>()
  const chats = db.prepare(`
    SELECT id, title, archived, worktree_path
      FROM conversations
     WHERE project_path = ? AND worktree_path IS NOT NULL
     ORDER BY archived ASC, updated_at DESC
  `).all(projectPath) as Array<{ id: string; title: string; archived: number; worktree_path: string }>
  for (const row of chats) {
    if (links.has(row.worktree_path)) continue
    links.set(row.worktree_path, { kind: 'chat', id: row.id, title: row.title, archived: row.archived === 1 })
  }
  const cards = db.prepare(`
    SELECT id, title, status, worktree_path
      FROM kanban_cards
     WHERE project_path = ? AND worktree_path IS NOT NULL
     ORDER BY updated_at DESC
  `).all(projectPath) as Array<{ id: string; title: string; status: string; worktree_path: string }>
  for (const row of cards) {
    if (links.has(row.worktree_path)) continue
    links.set(row.worktree_path, { kind: 'card', id: row.id, title: row.title, archived: row.status === 'done' })
  }
  return links
}
