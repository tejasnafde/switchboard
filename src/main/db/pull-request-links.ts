import Database from 'better-sqlite3'
import { normalizePrRef, type PrLink, type PrLinkChat, type PrLinkSource } from '@shared/pull-request-links'
import type { PrHost, PrRef } from '@shared/pull-requests'
import { getDb } from './database'
import { resolveRootThreadId, threadFamilyIds } from './conversations'

// ─── Chat ↔ pull request links ──────────────────────────────────
//
// Keyed by the ROOT conversation id (AGENTS.md: every per-conversation
// setting resolves through `resolveRootThreadId`). An unlinked row stays as a
// tombstone (`unlinked_at`), so an automatic link happens once and never
// comes back after the user removed it; linking by hand clears it.

export function ensurePullRequestLinkSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_pull_requests (
      conversation_id TEXT NOT NULL,
      host            TEXT NOT NULL,
      owner           TEXT NOT NULL,
      repo            TEXT NOT NULL,
      number          INTEGER NOT NULL,
      source          TEXT NOT NULL,
      linked_at       INTEGER NOT NULL,
      unlinked_at     INTEGER,
      PRIMARY KEY (conversation_id, host, owner, repo, number)
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_pull_requests_pr
      ON conversation_pull_requests(host, owner, repo, number);
  `)
}

interface LinkRow {
  host: PrHost
  owner: string
  repo: string
  number: number
  source: PrLinkSource
  linked_at: number
}

function keyArgs(ref: PrRef): [string, string, string, number] {
  const r = normalizePrRef(ref)
  return [r.host, r.owner, r.name, r.number]
}

export function listConversationPullRequests(threadId: string): PrLink[] {
  const rows = getDb().prepare(
    'SELECT host, owner, repo, number, source, linked_at FROM conversation_pull_requests WHERE conversation_id = ? AND unlinked_at IS NULL ORDER BY linked_at',
  ).all(resolveRootThreadId(threadId)) as LinkRow[]
  return rows.map((r) => ({ ref: { host: r.host, owner: r.owner, name: r.repo, number: r.number }, source: r.source, linkedAt: r.linked_at }))
}

/** Returns whether a link was added. An automatic link never revives one the user removed. */
export function linkConversationPullRequest(threadId: string, ref: PrRef, source: PrLinkSource, now = Date.now()): boolean {
  const args = [resolveRootThreadId(threadId), ...keyArgs(ref), now]
  const sql = source === 'auto'
    ? `INSERT OR IGNORE INTO conversation_pull_requests (conversation_id, host, owner, repo, number, source, linked_at) VALUES (?, ?, ?, ?, ?, 'auto', ?)`
    : `INSERT INTO conversation_pull_requests (conversation_id, host, owner, repo, number, source, linked_at) VALUES (?, ?, ?, ?, ?, 'manual', ?)
       ON CONFLICT(conversation_id, host, owner, repo, number) DO UPDATE SET unlinked_at = NULL, source = 'manual', linked_at = excluded.linked_at
       WHERE unlinked_at IS NOT NULL`
  return getDb().prepare(sql).run(...args).changes > 0
}

export function unlinkConversationPullRequest(threadId: string, ref: PrRef, now = Date.now()): boolean {
  return getDb().prepare(
    'UPDATE conversation_pull_requests SET unlinked_at = ? WHERE conversation_id = ? AND host = ? AND owner = ? AND repo = ? AND number = ? AND unlinked_at IS NULL',
  ).run(now, resolveRootThreadId(threadId), ...keyArgs(ref)).changes > 0
}

interface ChatRow {
  id: string
  title: string | null
  agent_type: string
  project_path: string
  updated_at: number
}

function toChat(row: ChatRow): PrLinkChat {
  return {
    id: row.id,
    familyIds: threadFamilyIds(row.id),
    title: row.title || 'New conversation',
    agentType: row.agent_type,
    projectPath: row.project_path,
    updatedAt: row.updated_at,
  }
}

export function listPullRequestChats(ref: PrRef): PrLinkChat[] {
  const rows = getDb().prepare(
    `SELECT c.id, c.title, c.agent_type, c.project_path, c.updated_at
     FROM conversation_pull_requests l JOIN conversations c ON c.id = l.conversation_id
     WHERE l.host = ? AND l.owner = ? AND l.repo = ? AND l.number = ? AND l.unlinked_at IS NULL AND c.archived = 0
     ORDER BY c.updated_at DESC`,
  ).all(...keyArgs(ref)) as ChatRow[]
  return rows.map(toChat)
}

/** Chats a PR can be linked to: live chats of the projects on its repository, newest first. */
export function listLinkableChats(projectPaths: readonly string[], limit = 200): PrLinkChat[] {
  if (projectPaths.length === 0) return []
  const rows = getDb().prepare(
    `SELECT id, title, agent_type, project_path, updated_at FROM conversations
     WHERE project_path IN (${projectPaths.map(() => '?').join(', ')})
       AND sidebar_role = 'managed' AND archived = 0 AND agent_type != 'terminal'
     ORDER BY updated_at DESC LIMIT ?`,
  ).all(...projectPaths, limit) as ChatRow[]
  return rows.map(toChat)
}
