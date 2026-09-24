import Database from 'better-sqlite3'
import { getDb } from './database'

// ─── Bookmarks (save-for-later on messages) ─────────────────────

export function ensureBookmarksTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id                TEXT PRIMARY KEY,
      session_id        TEXT NOT NULL,
      project_path      TEXT NOT NULL DEFAULT '',
      session_title     TEXT NOT NULL DEFAULT '',
      agent_type        TEXT NOT NULL DEFAULT 'claude-code',
      message_role      TEXT NOT NULL,
      content_excerpt   TEXT NOT NULL,
      message_timestamp INTEGER NOT NULL,
      saved_at          INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      UNIQUE(session_id, message_timestamp)
    );
    CREATE INDEX IF NOT EXISTS idx_bookmarks_saved_at ON bookmarks(saved_at DESC);
  `)
}

export interface BookmarkRow {
  id: string
  session_id: string
  project_path: string
  session_title: string
  agent_type: string
  message_role: string
  content_excerpt: string
  message_timestamp: number
  saved_at: number
}

export function saveBookmark(params: {
  id: string
  sessionId: string
  projectPath: string
  sessionTitle: string
  agentType: string
  messageRole: string
  contentExcerpt: string
  messageTimestamp: number
}): { ok: boolean } {
  try {
    getDb().prepare(
      `INSERT OR IGNORE INTO bookmarks
       (id, session_id, project_path, session_title, agent_type, message_role, content_excerpt, message_timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      params.id, params.sessionId, params.projectPath, params.sessionTitle,
      params.agentType, params.messageRole, params.contentExcerpt, params.messageTimestamp,
    )
    return { ok: true }
  } catch { return { ok: false } }
}

export function removeBookmark(id: string): { ok: boolean } {
  try {
    getDb().prepare('DELETE FROM bookmarks WHERE id = ?').run(id)
    return { ok: true }
  } catch { return { ok: false } }
}

export function listBookmarks(): BookmarkRow[] {
  return getDb()
    .prepare('SELECT * FROM bookmarks ORDER BY saved_at DESC')
    .all() as BookmarkRow[]
}
