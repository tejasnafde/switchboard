import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { createMainLogger as createLogger } from '../logger'

const log = createLogger('db')

let db: Database.Database | null = null

function getDbPath(): string {
  const userDataPath = app.getPath('userData')
  const dbDir = join(userDataPath, 'data')
  mkdirSync(dbDir, { recursive: true })
  return join(dbDir, 'switchboard.db')
}

export function getDb(): Database.Database {
  if (db) return db

  const dbPath = getDbPath()
  log.info(`opening database: ${dbPath}`)

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  migrate(db)
  return db
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      path TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      added_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      agent_type TEXT NOT NULL DEFAULT 'claude-code',
      session_id TEXT,
      title TEXT NOT NULL DEFAULT 'New conversation',
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      FOREIGN KEY (project_path) REFERENCES projects(path) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      tool_calls TEXT,
      images TEXT,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages(conversation_id, timestamp);

    CREATE INDEX IF NOT EXISTS idx_conversations_project
      ON conversations(project_path, updated_at DESC);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_layouts (
      session_id TEXT PRIMARY KEY,
      layout_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content, conversation_id UNINDEXED, role UNINDEXED,
      tokenize='unicode61'
    );

    -- Auto-sync FTS on insert/delete
    CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages
    WHEN NEW.content != ''
    BEGIN
      INSERT INTO messages_fts(rowid, content, conversation_id, role)
        VALUES (NEW.rowid, NEW.content, NEW.conversation_id, NEW.role);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages
    BEGIN
      DELETE FROM messages_fts WHERE rowid = OLD.rowid;
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages
    BEGIN
      DELETE FROM messages_fts WHERE rowid = OLD.rowid;
      INSERT INTO messages_fts(rowid, content, conversation_id, role)
        VALUES (NEW.rowid, NEW.content, NEW.conversation_id, NEW.role);
    END;
  `)

  // Migration: add `images` column to messages if missing
  try {
    const cols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'images')) {
      db.exec('ALTER TABLE messages ADD COLUMN images TEXT')
    }
  } catch { /* ignore */ }

  // Migration: add `archived` column to conversations if missing
  try {
    const cols = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'archived')) {
      db.exec('ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0')
    }
  } catch { /* ignore */ }

  // Thread ancestry — Claude's SDK can reassign `session_id` mid-conversation
  // (compaction, fork, restart), producing multiple .jsonl files for what the
  // user sees as one chat. This table maps each child session_id to its
  // root thread id (the stable id the user renamed, archived, etc.).
  //
  // Pattern borrowed from T3 Code's `projection_thread_sessions` spec —
  // "never overload orchestration thread id as Claude thread id."
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_sessions (
      claude_session_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      recorded_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_thread_sessions_thread ON thread_sessions(thread_id);
  `)

  // Migration: flatten any chain rows left over from before we started
  // flattening on insert. Without this, a chain like A→B→C means
  // listSessionIdsForThread(C) misses A. Walking each row to its
  // ultimate root and re-writing makes lookups O(1) again.
  try {
    const rows = db.prepare('SELECT claude_session_id, thread_id FROM thread_sessions').all() as Array<{
      claude_session_id: string; thread_id: string
    }>
    if (rows.length > 0) {
      const byChild = new Map(rows.map((r) => [r.claude_session_id, r.thread_id]))
      const rootOf = (id: string): string => {
        const seen = new Set<string>()
        let cur = id
        while (byChild.has(cur) && !seen.has(cur)) {
          seen.add(cur)
          const next = byChild.get(cur)!
          if (next === cur) break
          cur = next
        }
        return cur
      }
      const update = db.prepare('UPDATE thread_sessions SET thread_id = ? WHERE claude_session_id = ?')
      let rewrote = 0
      db.transaction(() => {
        for (const r of rows) {
          const root = rootOf(r.thread_id)
          if (root !== r.thread_id) {
            update.run(root, r.claude_session_id)
            rewrote++
          }
        }
      })()
      if (rewrote > 0) log.info(`thread_sessions: flattened ${rewrote} chain row(s) to ultimate roots`)
    }
  } catch { /* best-effort — flattening can be re-run on next launch */ }

  // Rebuild FTS index from existing messages
  try {
    const ftsCount = (db.prepare('SELECT count(*) as c FROM messages_fts').get() as { c: number } | undefined)?.c ?? 0
    const msgCount = (db.prepare("SELECT count(*) as c FROM messages WHERE content != ''").get() as { c: number } | undefined)?.c ?? 0
    if (ftsCount < msgCount) {
      db.exec("DELETE FROM messages_fts;")
      db.exec(`
        INSERT INTO messages_fts(rowid, content, conversation_id, role)
          SELECT rowid, content, conversation_id, role FROM messages WHERE content != '';
      `)
    }
  } catch { /* FTS rebuild failed — not critical */ }

  log.info('database migrated')
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

// ─── Project CRUD ────────────────────────────────────────────────

export function addProject(path: string, name: string): void {
  getDb().prepare(
    'INSERT OR IGNORE INTO projects (path, name) VALUES (?, ?)'
  ).run(path, name)
}

export function getProjects(): Array<{ path: string; name: string; added_at: number }> {
  return getDb().prepare('SELECT * FROM projects ORDER BY added_at DESC').all() as Array<{
    path: string
    name: string
    added_at: number
  }>
}

export function removeProject(path: string): void {
  getDb().prepare('DELETE FROM projects WHERE path = ?').run(path)
}

// ─── Conversation CRUD ──────────────────────────────────────────

export function createConversation(
  id: string,
  projectPath: string,
  agentType: string,
  title?: string,
): void {
  const now = Date.now()
  getDb().prepare(
    `INSERT OR IGNORE INTO conversations (id, project_path, agent_type, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, projectPath, agentType, title ?? 'New conversation', now, now)
}

export function updateConversationSessionId(id: string, sessionId: string): void {
  getDb().prepare(
    'UPDATE conversations SET session_id = ?, updated_at = ? WHERE id = ?'
  ).run(sessionId, Date.now(), id)
}

export function updateConversationTitle(id: string, title: string): void {
  getDb().prepare(
    'UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?'
  ).run(title, Date.now(), id)
}

export function getConversationsForProject(projectPath: string): ConversationRow[] {
  return getDb().prepare(
    'SELECT * FROM conversations WHERE project_path = ? ORDER BY updated_at DESC'
  ).all(projectPath) as ConversationRow[]
}

export interface ConversationRow {
  id: string
  project_path: string
  agent_type: string
  session_id: string | null
  title: string
  created_at: number
  updated_at: number
  archived: number
}

/** Look up a single conversation by id. Used by search navigation to
 *  hydrate a session the user jumped into from ⌘⇧F. */
export function getConversationById(id: string): ConversationRow | undefined {
  return getDb().prepare(
    'SELECT * FROM conversations WHERE id = ?'
  ).get(id) as ConversationRow | undefined
}

// ─── Thread ancestry ─────────────────────────────────────────────

/**
 * Record that `claudeSessionId` belongs to `threadId`.
 *
 * FLATTENS the chain on insert — if `threadId` is itself a child of some
 * deeper root, we resolve to that root first. And if `claudeSessionId`
 * already has descendants, we re-parent them too. Result: the table
 * always stores a two-level relationship (leaf → ultimate root), never
 * chains like `A → B → C`.
 *
 * Without flattening, `listSessionIdsForThread(C)` would miss A because
 * A's direct parent is B, not C.
 */
export function recordThreadSession(claudeSessionId: string, threadId: string): void {
  if (claudeSessionId === threadId) return // self-reference — nothing to track
  const db = getDb()
  const now = Date.now()

  // Walk up from `threadId` to the ultimate root (in case the caller
  // passed an intermediate that's itself a child of something else).
  const root = resolveRootThreadId(threadId)
  if (root === claudeSessionId) return // would create a cycle; refuse

  db.transaction(() => {
    // Set claudeSessionId → root
    db.prepare(
      'INSERT OR REPLACE INTO thread_sessions (claude_session_id, thread_id, recorded_at) VALUES (?, ?, ?)'
    ).run(claudeSessionId, root, now)
    // Re-parent anything that previously pointed at claudeSessionId so
    // they all point at the new root (chain flattening).
    db.prepare(
      'UPDATE thread_sessions SET thread_id = ? WHERE thread_id = ?'
    ).run(root, claudeSessionId)
  })()
}

/**
 * Return the root thread_id for a given claude_session_id. Walks the
 * parent chain until it hits a terminal (no row) — handles legacy rows
 * from before `recordThreadSession` flattened on insert.
 */
export function resolveRootThreadId(claudeSessionId: string): string {
  const stmt = getDb().prepare(
    'SELECT thread_id FROM thread_sessions WHERE claude_session_id = ?'
  )
  let cur = claudeSessionId
  const seen = new Set<string>()
  while (true) {
    if (seen.has(cur)) return cur // cycle guard (shouldn't happen)
    seen.add(cur)
    const row = stmt.get(cur) as { thread_id: string } | undefined
    if (!row || row.thread_id === cur) return cur
    cur = row.thread_id
  }
}

/**
 * Every claude_session_id that belongs to a given thread (as root). Walks
 * down all descendant links, so a chain `A → B → C` where we ask for `C`
 * returns `[C, B, A]` regardless of how the chain was recorded.
 *
 * Always includes `threadId` itself so callers don't need to special-case.
 */
export function listSessionIdsForThread(threadId: string): string[] {
  const db = getDb()
  const directStmt = db.prepare(
    'SELECT claude_session_id, recorded_at FROM thread_sessions WHERE thread_id = ? ORDER BY recorded_at ASC'
  )
  const result: string[] = [threadId]
  const visited = new Set<string>([threadId])
  // BFS — each queued id's direct children are added. With flattening
  // this is usually a single layer, but the walk handles legacy chains.
  const queue: string[] = [threadId]
  while (queue.length > 0) {
    const id = queue.shift()!
    const rows = directStmt.all(id) as Array<{ claude_session_id: string; recorded_at: number }>
    for (const r of rows) {
      if (visited.has(r.claude_session_id)) continue
      visited.add(r.claude_session_id)
      result.push(r.claude_session_id)
      queue.push(r.claude_session_id)
    }
  }
  return result
}

/**
 * Returns the set of claude_session_ids that are CHILDREN of some other
 * thread — used to hide fragmented .jsonl files from the sidebar scanner.
 *
 * IMPORTANT: Only hide UUIDs whose parent is ALSO a real UUID (i.e. has
 * its own .jsonl on disk). If the parent is a synthetic `agent_<ts>` ID
 * (Switchboard-native, never written to disk), hiding the UUID would make
 * the whole chat invisible — the synthetic parent has no scanner entry to
 * stand in for it. So we keep those UUIDs visible and inherit the title
 * from the synthetic parent via `getThreadParentMap()`.
 */
export function getChildSessionIds(): Set<string> {
  const rows = getDb().prepare(
    "SELECT claude_session_id FROM thread_sessions " +
    "WHERE thread_id != claude_session_id " +
    "AND thread_id NOT LIKE 'agent\\_%' ESCAPE '\\'"
  ).all() as Array<{ claude_session_id: string }>
  return new Set(rows.map((r) => r.claude_session_id))
}

/**
 * Returns a map of claude_session_id → synthetic parent thread_id (only for
 * rows where thread_id is a Switchboard-native `agent_<ts>` ID). Used by
 * the sidebar to inherit the parent conversation's title for child UUIDs
 * whose synthetic parent has no .jsonl on disk.
 */
export function getSyntheticParentMap(): Map<string, string> {
  const rows = getDb().prepare(
    "SELECT claude_session_id, thread_id FROM thread_sessions " +
    "WHERE thread_id LIKE 'agent\\_%' ESCAPE '\\' " +
    "AND thread_id != claude_session_id"
  ).all() as Array<{ claude_session_id: string; thread_id: string }>
  return new Map(rows.map((r) => [r.claude_session_id, r.thread_id]))
}

/**
 * Remove a row from thread_sessions, detaching a hidden child back to the
 * sidebar as its own conversation. Used when an automatic ancestry record
 * was wrong (e.g. we captured a session_id from an unrelated attach).
 */
export function detachSession(claudeSessionId: string): boolean {
  const result = getDb().prepare(
    'DELETE FROM thread_sessions WHERE claude_session_id = ?'
  ).run(claudeSessionId)
  return result.changes > 0
}

/**
 * Dump all ancestry rows — used for debugging via the devtools console.
 * Not called by any UI path; exposed through the `app:list-ancestry` IPC
 * so you can run `window.api.app.listAncestry()` to see the full state.
 */
export function listAllThreadSessions(): Array<{
  claude_session_id: string
  thread_id: string
  recorded_at: number
}> {
  return getDb().prepare(
    'SELECT claude_session_id, thread_id, recorded_at FROM thread_sessions ORDER BY recorded_at DESC'
  ).all() as Array<{ claude_session_id: string; thread_id: string; recorded_at: number }>
}

export function archiveConversation(id: string): void {
  getDb().prepare(
    'UPDATE conversations SET archived = 1, updated_at = ? WHERE id = ?'
  ).run(Date.now(), id)
}

export function unarchiveConversation(id: string): void {
  getDb().prepare(
    'UPDATE conversations SET archived = 0, updated_at = ? WHERE id = ?'
  ).run(Date.now(), id)
}

export function getArchivedConversations(): Array<{ id: string; project_path: string; title: string; updated_at: number }> {
  return getDb().prepare(
    'SELECT id, project_path, title, updated_at FROM conversations WHERE archived = 1 ORDER BY updated_at DESC'
  ).all() as Array<{ id: string; project_path: string; title: string; updated_at: number }>
}

export function isConversationArchived(id: string): boolean {
  const row = getDb().prepare(
    'SELECT archived FROM conversations WHERE id = ?'
  ).get(id) as { archived: number } | undefined
  return row?.archived === 1
}

/**
 * Returns the set of ALL archived conversation IDs, regardless of project_path.
 * Used when filtering scanned sessions so that a conversation archived under
 * one project_path doesn't reappear under a different project_path view
 * (can happen when sessions bleed across projects that share path prefixes).
 */
export function getArchivedConversationIds(): Set<string> {
  const rows = getDb().prepare(
    'SELECT id FROM conversations WHERE archived = 1'
  ).all() as Array<{ id: string }>
  return new Set(rows.map((r) => r.id))
}

/**
 * Ensure a row exists in conversations (so archive/title ops have something to update).
 * Used when a session comes from scanning JSONL (not yet in DB).
 */
export function ensureConversation(id: string, projectPath: string, agentType: string, title: string): void {
  getDb().prepare(
    `INSERT OR IGNORE INTO conversations (id, project_path, agent_type, title)
     VALUES (?, ?, ?, ?)`
  ).run(id, projectPath, agentType, title)
}

/**
 * Bulk-save messages from an imported session (e.g., JSONL load).
 * Uses a transaction for performance. Triggers auto-populate FTS.
 */
export function bulkSaveMessages(
  conversationId: string,
  messages: Array<{ id: string; role: string; content: string; timestamp: number }>,
): void {
  const db = getDb()

  // Skip silently if the conversation row doesn't exist — same guard as saveMessage
  const convExists = db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId)
  if (!convExists) {
    log.warn(`bulkSaveMessages: conversation ${conversationId} not found, skipping`)
    return
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO messages (id, conversation_id, role, content, timestamp)
     VALUES (?, ?, ?, ?, ?)`
  )

  const tx = db.transaction(() => {
    for (const msg of messages) {
      if (!msg.content) continue
      insert.run(msg.id, conversationId, msg.role, msg.content, msg.timestamp)
    }
  })
  tx()
}

// ─── Message CRUD ───────────────────────────────────────────────

export function saveMessage(
  id: string,
  conversationId: string,
  role: string,
  content: string,
  toolCalls?: string,
  images?: string,
): void {
  const now = Date.now()
  const db = getDb()

  // Skip silently if the conversation row doesn't exist — happens when a session
  // was imported (scanned from JSONL) but never persisted to the conversations
  // table. The renderer will call createConversation on session activation, but
  // this guard protects against race/edge cases so we don't throw.
  const convExists = db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId)
  if (!convExists) {
    log.warn(`saveMessage: conversation ${conversationId} not found, skipping`)
    return
  }

  db.prepare(
    `INSERT OR REPLACE INTO messages (id, conversation_id, role, content, tool_calls, images, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, conversationId, role, content, toolCalls ?? null, images ?? null, now)

  db.prepare(
    'UPDATE conversations SET updated_at = ? WHERE id = ?'
  ).run(now, conversationId)
}

export interface MessageRow {
  id: string
  conversation_id: string
  role: string
  content: string
  tool_calls: string | null
  images: string | null
  timestamp: number
}

export function getMessagesForConversation(conversationId: string): MessageRow[] {
  return getDb().prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC'
  ).all(conversationId) as MessageRow[]
}

// ─── Settings CRUD ──────────────────────────────────────────────

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  getDb().prepare(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
  ).run(key, value)
}

export function removeSetting(key: string): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key)
}

// ─── Session Layout CRUD ───────────────────────────────────────

export function saveSessionLayout(sessionId: string, layoutJson: string): void {
  getDb().prepare(
    'INSERT OR REPLACE INTO session_layouts (session_id, layout_json, updated_at) VALUES (?, ?, ?)'
  ).run(sessionId, layoutJson, Date.now())
}

export function getSessionLayout(sessionId: string): string | null {
  const row = getDb().prepare(
    'SELECT layout_json FROM session_layouts WHERE session_id = ?'
  ).get(sessionId) as { layout_json: string } | undefined
  return row?.layout_json ?? null
}

export function removeSessionLayout(sessionId: string): void {
  getDb().prepare('DELETE FROM session_layouts WHERE session_id = ?').run(sessionId)
}

// ─── Search ────────────────────────────────────────────────────

export interface SearchResult {
  messageId: string
  conversationId: string
  role: string
  content: string
  snippet: string
}

export function searchMessages(query: string, limit = 50): SearchResult[] {
  // Sanitize query for FTS5
  const sanitized = query.replace(/['"]/g, ' ').trim()
  if (!sanitized) return []

  try {
    return getDb().prepare(`
      SELECT
        m.id as messageId,
        m.conversation_id as conversationId,
        m.role,
        m.content,
        snippet(messages_fts, 0, '**', '**', '...', 40) as snippet
      FROM messages_fts
      JOIN messages m ON messages_fts.rowid = m.rowid
      WHERE messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(sanitized, limit) as SearchResult[]
  } catch {
    // FTS query syntax error — fall back to LIKE
    return getDb().prepare(`
      SELECT
        id as messageId,
        conversation_id as conversationId,
        role,
        content,
        substr(content, max(1, instr(lower(content), lower(?)) - 20), 80) as snippet
      FROM messages
      WHERE content LIKE ?
      LIMIT ?
    `).all(sanitized, `%${sanitized}%`, limit) as SearchResult[]
  }
}
