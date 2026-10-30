import Database from 'better-sqlite3'
import { getDb } from './database'
import { resolveRootThreadId } from './conversations'

// ─── Agent secrets ──────────────────────────────────────────────
//
// Metadata for the files `request_secret` saves (`main/secrets/secret-store.ts`).
// Never the value, a hash of it or its length. `agent_secret_dirs` holds each
// chat's random folder name, made at session start before any secret exists;
// `agent_secrets` holds one row per saved file. Both keyed by the ROOT
// conversation id, so a provider session id rotation finds the same folder.
// `agent_secret_owner_deleted` lists root chats whose conversation row was
// deleted (with its project) while it still held secrets, so the sweep can
// tell them from a new chat whose folder comes before its row.

export function ensureAgentSecretsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_secret_dirs (
      root_thread_id TEXT PRIMARY KEY,
      dir_id         TEXT NOT NULL UNIQUE,
      created_at     INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_secrets (
      id             TEXT PRIMARY KEY,
      root_thread_id TEXT NOT NULL,
      dir_id         TEXT NOT NULL,
      name           TEXT NOT NULL,
      machine_id     TEXT,
      card_id        TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      expires_at     INTEGER NOT NULL,
      deleted_at     INTEGER
    );
    CREATE TABLE IF NOT EXISTS agent_secret_owner_deleted (
      root_thread_id TEXT PRIMARY KEY,
      deleted_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_secrets_live
      ON agent_secrets(root_thread_id, name) WHERE deleted_at IS NULL;
  `)
}

export interface AgentSecretRow {
  id: string
  rootThreadId: string
  dirId: string
  name: string
  machineId: string | null
  cardId: string
  createdAt: number
  expiresAt: number
  deletedAt: number | null
}

interface Row {
  id: string
  root_thread_id: string
  dir_id: string
  name: string
  machine_id: string | null
  card_id: string
  created_at: number
  expires_at: number
  deleted_at: number | null
}

function fromRow(r: Row): AgentSecretRow {
  return {
    id: r.id,
    rootThreadId: r.root_thread_id,
    dirId: r.dir_id,
    name: r.name,
    machineId: r.machine_id,
    cardId: r.card_id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    deletedAt: r.deleted_at,
  }
}

export function getSecretDirId(threadId: string): string | null {
  const row = getDb()
    .prepare('SELECT dir_id FROM agent_secret_dirs WHERE root_thread_id = ?')
    .get(resolveRootThreadId(threadId)) as { dir_id: string } | undefined
  return row?.dir_id ?? null
}

/** The chat's folder name, recording `dirId` when it has none yet. */
export function claimSecretDirId(threadId: string, dirId: string, now: number): string {
  const root = resolveRootThreadId(threadId)
  getDb()
    .prepare('INSERT OR IGNORE INTO agent_secret_dirs (root_thread_id, dir_id, created_at) VALUES (?, ?, ?)')
    .run(root, dirId, now)
  return getSecretDirId(root) as string
}

export function listSecretDirIds(): Set<string> {
  const rows = getDb().prepare('SELECT dir_id FROM agent_secret_dirs').all() as { dir_id: string }[]
  return new Set(rows.map((r) => r.dir_id))
}

const SECRET_HOLDERS = `SELECT root_thread_id FROM agent_secret_dirs
  UNION SELECT root_thread_id FROM agent_secrets WHERE deleted_at IS NULL`

/**
 * Root chats that still hold a secrets folder or a live secret but are
 * archived, or whose conversation was deleted and not added back. A chat with no conversation
 * row and no deletion record is left alone: a new chat's folder is made at
 * session start, which can come before its row.
 */
export function listArchivedSecretChats(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT r.root_thread_id AS id FROM (${SECRET_HOLDERS}) r
       WHERE r.root_thread_id IN (SELECT id FROM conversations WHERE archived = 1)
          OR (r.root_thread_id IN (SELECT root_thread_id FROM agent_secret_owner_deleted)
              AND r.root_thread_id NOT IN (SELECT id FROM conversations))`,
    )
    .all() as { id: string }[]
  return rows.map((r) => r.id)
}

/**
 * Record every chat of `projectPath` that holds secrets as deleted. Run in the
 * transaction that deletes the project, before its conversation rows go, so
 * the sweep still finds them if the delete right after fails. Returns them.
 */
export function markProjectSecretOwnersDeleted(db: Database.Database, projectPath: string, now: number): string[] {
  const rows = db
    .prepare(`SELECT id FROM conversations WHERE project_path = ? AND id IN (${SECRET_HOLDERS})`)
    .all(projectPath) as { id: string }[]
  const insert = db.prepare(
    'INSERT OR IGNORE INTO agent_secret_owner_deleted (root_thread_id, deleted_at) VALUES (?, ?)',
  )
  for (const r of rows) insert.run(r.id, now)
  return rows.map((r) => r.id)
}

/** Drop the deletion records of chats that hold nothing any more, or whose conversation is back (a re-added project). */
export function pruneSecretOwnerDeleted(): void {
  getDb()
    .prepare(
      `DELETE FROM agent_secret_owner_deleted
       WHERE root_thread_id NOT IN (${SECRET_HOLDERS}) OR root_thread_id IN (SELECT id FROM conversations)`,
    )
    .run()
}

export function deleteSecretDir(threadId: string): void {
  getDb().prepare('DELETE FROM agent_secret_dirs WHERE root_thread_id = ?').run(resolveRootThreadId(threadId))
}

/**
 * Record a saved file. An older live row for the same chat and name is marked
 * deleted in the same transaction: the rename that wrote this file replaced it.
 */
export function insertAgentSecret(
  row: Omit<AgentSecretRow, 'deletedAt' | 'rootThreadId'> & { threadId: string },
): void {
  const db = getDb()
  const root = resolveRootThreadId(row.threadId)
  db.transaction(() => {
    db.prepare(
      'UPDATE agent_secrets SET deleted_at = ? WHERE root_thread_id = ? AND name = ? AND deleted_at IS NULL',
    ).run(row.createdAt, root, row.name)
    db.prepare(
      `INSERT INTO agent_secrets (id, root_thread_id, dir_id, name, machine_id, card_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, root, row.dirId, row.name, row.machineId, row.cardId, row.createdAt, row.expiresAt)
  })()
}

export function getAgentSecret(id: string): AgentSecretRow | null {
  const row = getDb().prepare('SELECT * FROM agent_secrets WHERE id = ?').get(id) as Row | undefined
  return row ? fromRow(row) : null
}

export function listLiveAgentSecrets(threadId?: string): AgentSecretRow[] {
  const rows = (
    threadId === undefined
      ? getDb().prepare('SELECT * FROM agent_secrets WHERE deleted_at IS NULL').all()
      : getDb()
          .prepare('SELECT * FROM agent_secrets WHERE deleted_at IS NULL AND root_thread_id = ?')
          .all(resolveRootThreadId(threadId))
  ) as Row[]
  return rows.map(fromRow)
}

export function setAgentSecretExpiry(id: string, expiresAt: number): boolean {
  return (
    getDb().prepare('UPDATE agent_secrets SET expires_at = ? WHERE id = ? AND deleted_at IS NULL').run(expiresAt, id)
      .changes > 0
  )
}

export function markAgentSecretDeleted(id: string, now: number): void {
  getDb().prepare('UPDATE agent_secrets SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, id)
}

/** Every row of one chat, deleted ones too, newest first: the saved lines read their state from it. */
export function listChatAgentSecrets(threadId: string, limit = 200): AgentSecretRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM agent_secrets WHERE root_thread_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(resolveRootThreadId(threadId), limit) as Row[]
  return rows.map(fromRow)
}
