import Database from 'better-sqlite3'
import { normalizePrRef, type PrLink, type PrLinkChat, type PrLinkSource } from '@shared/pull-request-links'
import type { PrHost, PrRef, PrState } from '@shared/pull-requests'
import { getDb } from './database'
import { resolveRootThreadId, threadFamilyIds } from './conversations'

// ─── Chat ↔ pull request links ──────────────────────────────────
//
// Keyed by the ROOT conversation id (AGENTS.md: every per-conversation
// setting resolves through `resolveRootThreadId`). An unlinked row stays as a
// tombstone (`unlinked_at`), so an automatic link happens once and never
// comes back after the user removed it; an explicit link (the user's or an
// agent's) clears it. `source` says how the link was made (`PrLinkSource`);
// `state` is the PR's state when the backend last read it.

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

    CREATE TABLE IF NOT EXISTS conversation_pr_history_scans (
      conversation_id TEXT PRIMARY KEY,
      scanned_at      INTEGER NOT NULL
    );
  `)
  // Added with link state (0.9.29). Existing rows keep their source: a PR an
  // agent opened before then stays 'manual', since nothing recorded the difference.
  const columns = new Set((db.prepare('PRAGMA table_info(conversation_pull_requests)').all() as { name: string }[]).map((c) => c.name))
  if (!columns.has('state')) db.exec('ALTER TABLE conversation_pull_requests ADD COLUMN state TEXT')
  if (!columns.has('state_at')) db.exec('ALTER TABLE conversation_pull_requests ADD COLUMN state_at INTEGER')
}

interface LinkRow {
  host: PrHost
  owner: string
  repo: string
  number: number
  source: PrLinkSource
  linked_at: number
  state: PrState | null
  state_at: number | null
}

function keyArgs(ref: PrRef): [string, string, string, number] {
  const r = normalizePrRef(ref)
  return [r.host, r.owner, r.name, r.number]
}

export function listConversationPullRequests(threadId: string): PrLink[] {
  const rows = getDb().prepare(
    'SELECT host, owner, repo, number, source, linked_at, state, state_at FROM conversation_pull_requests WHERE conversation_id = ? AND unlinked_at IS NULL ORDER BY linked_at',
  ).all(resolveRootThreadId(threadId)) as LinkRow[]
  return rows.map((r) => ({
    ref: { host: r.host, owner: r.owner, name: r.repo, number: r.number },
    source: r.source,
    linkedAt: r.linked_at,
    state: r.state ?? null,
    stateAt: r.state_at ?? null,
  }))
}

/**
 * Returns whether a link was added or changed. An automatic link never
 * revives one the user removed; an explicit one does, and replaces an
 * automatic link's source with its own (the agent opened it, the user confirmed it).
 */
export function linkConversationPullRequest(threadId: string, ref: PrRef, source: PrLinkSource, now = Date.now()): boolean {
  const args = [resolveRootThreadId(threadId), ...keyArgs(ref), source, now]
  const sql = source === 'auto'
    ? `INSERT OR IGNORE INTO conversation_pull_requests (conversation_id, host, owner, repo, number, source, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    : `INSERT INTO conversation_pull_requests (conversation_id, host, owner, repo, number, source, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id, host, owner, repo, number) DO UPDATE SET
         source = excluded.source,
         linked_at = CASE WHEN unlinked_at IS NOT NULL THEN excluded.linked_at ELSE linked_at END,
         unlinked_at = NULL
       WHERE unlinked_at IS NOT NULL OR (source = 'auto' AND excluded.source != 'auto')`
  return getDb().prepare(sql).run(...args).changes > 0
}

/**
 * Records a PR's state on every live link to it. Returns the root chats whose
 * link changed state, so their clients re-read it.
 */
export function setPullRequestLinkState(ref: PrRef, state: PrState, now = Date.now()): string[] {
  const db = getDb()
  const key = keyArgs(ref)
  const where = 'host = ? AND owner = ? AND repo = ? AND number = ? AND unlinked_at IS NULL'
  return db.transaction(() => {
    const changed = (db.prepare(
      `SELECT conversation_id FROM conversation_pull_requests WHERE ${where} AND (state IS NULL OR state != ?)`,
    ).all(...key, state) as { conversation_id: string }[]).map((r) => r.conversation_id)
    // Every live row gets the time, so a refresh that found no change is not repeated at once.
    db.prepare(`UPDATE conversation_pull_requests SET state = ?, state_at = ? WHERE ${where}`).run(state, now, ...key)
    return changed
  })()
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
  source?: PrLinkSource
}

function toChat(row: ChatRow): PrLinkChat {
  return {
    id: row.id,
    familyIds: threadFamilyIds(row.id),
    title: row.title || 'New conversation',
    agentType: row.agent_type,
    projectPath: row.project_path,
    updatedAt: row.updated_at,
    ...(row.source ? { linkSource: row.source } : {}),
  }
}

export function listPullRequestChats(ref: PrRef): PrLinkChat[] {
  const rows = getDb().prepare(
    `SELECT c.id, c.title, c.agent_type, c.project_path, c.updated_at, l.source
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

/** Root chats the one-time history scan has not read yet, newest first. */
export function listUnscannedPullRequestHistoryScanTargets(limit: number): { id: string; projectPath: string; worktreePath: string | null }[] {
  return getDb().prepare(
    `SELECT c.id, c.project_path AS projectPath, c.worktree_path AS worktreePath
       FROM conversations c
       LEFT JOIN conversation_pr_history_scans s ON s.conversation_id = c.id
      WHERE s.conversation_id IS NULL
        AND c.agent_type != 'terminal'
        AND NOT EXISTS (
          SELECT 1 FROM thread_sessions ts
           WHERE ts.claude_session_id = c.id AND ts.thread_id != c.id
        )
      ORDER BY c.updated_at DESC
      LIMIT ?`,
  ).all(Math.max(1, limit)) as { id: string; projectPath: string; worktreePath: string | null }[]
}

export function markPullRequestHistoryScanned(threadId: string, now = Date.now()): void {
  getDb().prepare(
    `INSERT INTO conversation_pr_history_scans (conversation_id, scanned_at) VALUES (?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET scanned_at = excluded.scanned_at`,
  ).run(resolveRootThreadId(threadId), now)
}
