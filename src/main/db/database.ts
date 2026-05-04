import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { createMainLogger as createLogger } from '../logger'
import type { KanbanCard, KanbanCardCreate, KanbanCardUpdate, KanbanStatus } from '@shared/kanban'
import { KANBAN_DEFAULT_RUNTIME_MODE } from '@shared/kanban'
import { applyKanbanArchiveSideEffect } from '@shared/kanbanArchive'
import type { RuntimeMode } from '@shared/provider-events'
import { AGENT_TYPES, defaultInstanceId } from '@shared/types'

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
    // Migration: pill-aware display body for sent user messages — see
    // `getDisplayBodyEnrichments` and `enrichMessagesWithDisplayBody`.
    if (!cols.some((c) => c.name === 'display_body')) {
      db.exec('ALTER TABLE messages ADD COLUMN display_body TEXT')
    }
    if (!cols.some((c) => c.name === 'pills_meta')) {
      db.exec('ALTER TABLE messages ADD COLUMN pills_meta TEXT')
    }
  } catch { /* ignore */ }

  // Migration: add `archived` column to conversations if missing
  try {
    const cols = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'archived')) {
      db.exec('ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0')
    }
    // Migration (2026-05-04): persist the per-conversation runtime mode
    // (plan / sandbox / accept-edits / full-access) so reopening a chat —
    // especially via a kanban card click — restores the user's actual
    // selection instead of falling back to the hardcoded 'sandbox' default.
    if (!cols.some((c) => c.name === 'runtime_mode')) {
      db.exec('ALTER TABLE conversations ADD COLUMN runtime_mode TEXT')
    }
    // Migration (#4 — fork-from-message): record fork lineage so the
    // sidebar (and future audit tools) can reconstruct parent → child.
    // Both nullable so existing conversations stay valid without a
    // backfill. `forked_at_message_id` references a message in the
    // *parent* conversation's row set; we don't add a FK because the
    // referenced row may live in a thread fragment whose canonical id
    // changed (Claude SDK rotation), and a hard FK would block forks.
    if (!cols.some((c) => c.name === 'parent_conversation_id')) {
      db.exec('ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT')
    }
    if (!cols.some((c) => c.name === 'forked_at_message_id')) {
      db.exec('ALTER TABLE conversations ADD COLUMN forked_at_message_id TEXT')
    }
    // Migration (#5 — fork-to-worktree): when the user opts a fork into
    // its own git worktree, persist the worktree path + branch so the
    // sidebar can render a friendly `<repo> · <branch>` label and any
    // future cleanup flow can locate the on-disk checkout. Both are
    // nullable; conversations forked without `withWorktree` (or any
    // pre-#5 conversation) leave them null and behave exactly as before.
    if (!cols.some((c) => c.name === 'worktree_path')) {
      db.exec('ALTER TABLE conversations ADD COLUMN worktree_path TEXT')
    }
    if (!cols.some((c) => c.name === 'worktree_branch')) {
      db.exec('ALTER TABLE conversations ADD COLUMN worktree_branch TEXT')
    }
  } catch { /* ignore */ }

  // Migration (v0.1.20): track which workspace template a session
  // hydrated from, so the per-chat picker can show the correct
  // current selection and so hot-reloads of workspace.yaml know
  // which named template to respawn.
  try {
    const cols = db.prepare("PRAGMA table_info(session_layouts)").all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'template_name')) {
      db.exec('ALTER TABLE session_layouts ADD COLUMN template_name TEXT')
    }
  } catch { /* ignore */ }

  // ─── Workspaces (outer sidebar grouping above projects) ──────────
  // A project belongs to at most one workspace via the nullable
  // `workspace_id` FK. ON DELETE SET NULL means deleting a workspace
  // returns its projects to the implicit "Ungrouped" pseudo-bucket
  // — never destroys data.
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_workspaces (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      color       TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `)
  try {
    const cols = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'workspace_id')) {
      db.exec('ALTER TABLE projects ADD COLUMN workspace_id TEXT REFERENCES project_workspaces(id) ON DELETE SET NULL')
    }
  } catch { /* ignore */ }
  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);')

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

  // ─── Kanban (v0.1.26) ────────────────────────────────────────────
  // Per-project task cards. `tags` is JSON-encoded (SQLite has no
  // native array type). `worktree_path` / `worktree_branch` are set
  // iff the card opted into an isolated git worktree.
  db.exec(`
    CREATE TABLE IF NOT EXISTS kanban_cards (
      id              TEXT PRIMARY KEY,
      project_path    TEXT NOT NULL,
      title           TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      tags            TEXT NOT NULL DEFAULT '[]',
      status          TEXT NOT NULL DEFAULT 'backlog',
      cost_cap_usd    REAL,
      cost_used_usd   REAL,
      runtime_mode    TEXT NOT NULL DEFAULT 'accept-edits',
      conversation_id TEXT,
      worktree_path   TEXT,
      worktree_branch TEXT,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      completed_at    INTEGER,
      FOREIGN KEY (project_path) REFERENCES projects(path) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_project_status
      ON kanban_cards(project_path, status, updated_at DESC);
  `)

  // Migration: add `runtime_mode` to kanban_cards if missing. Existing
  // rows backfill to `accept-edits` to match the new default.
  try {
    const cols = db.prepare("PRAGMA table_info(kanban_cards)").all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'runtime_mode')) {
      db.exec("ALTER TABLE kanban_cards ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'accept-edits'")
    }
  } catch { /* ignore */ }

  // Provider instances: named credential sets scoped to an agent kind.
  // See src/main/db/providerInstances.ts for the encryption contract.
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_instances (
      id            TEXT PRIMARY KEY,
      agent_type    TEXT NOT NULL,
      display_name  TEXT NOT NULL,
      accent_color  TEXT,
      auth_mode     TEXT NOT NULL DEFAULT 'env',
      env_encrypted BLOB,
      oauth_dir     TEXT,
      config_json   TEXT,
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_instances_agent
      ON provider_instances(agent_type);
  `)

  // Seed one default instance per agent kind (idempotent via OR IGNORE).
  const seed = db.prepare(
    `INSERT OR IGNORE INTO provider_instances
       (id, agent_type, display_name, auth_mode, enabled)
     VALUES (?, ?, 'Default', 'env', 1)`
  )
  for (const kind of AGENT_TYPES) {
    seed.run(defaultInstanceId(kind), kind)
  }

  // Backfill conversations.provider_instance_id from agent_type.
  const convCols = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>
  if (!convCols.some((c) => c.name === 'provider_instance_id')) {
    db.exec('ALTER TABLE conversations ADD COLUMN provider_instance_id TEXT')
  }
  db.exec(`
    UPDATE conversations
       SET provider_instance_id = agent_type || '-default'
     WHERE provider_instance_id IS NULL
  `)

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

export function getProjects(): Array<{ path: string; name: string; added_at: number; workspace_id: string | null }> {
  return getDb().prepare(
    'SELECT path, name, added_at, workspace_id FROM projects ORDER BY added_at DESC'
  ).all() as Array<{
    path: string
    name: string
    added_at: number
    workspace_id: string | null
  }>
}

export function removeProject(path: string): void {
  getDb().prepare('DELETE FROM projects WHERE path = ?').run(path)
}

// ─── Workspace CRUD ──────────────────────────────────────────────

export interface WorkspaceRow {
  id: string
  name: string
  color: string | null
  sort_order: number
  created_at: number
}

function makeWorkspaceId(): string {
  // Uniqueness only matters within this DB; collision odds are nil.
  return 'ws_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

export function listWorkspaces(): WorkspaceRow[] {
  return getDb().prepare(
    'SELECT id, name, color, sort_order, created_at FROM project_workspaces ORDER BY sort_order ASC, created_at ASC'
  ).all() as WorkspaceRow[]
}

export function createWorkspace(input: { name: string; color?: string | null }): WorkspaceRow {
  const id = makeWorkspaceId()
  const now = Date.now()
  // New workspaces sort to the end. We compute max(sort_order)+1 so an
  // explicit reorder isn't needed for the first N workspaces a user adds.
  const maxRow = getDb().prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM project_workspaces').get() as { m: number }
  const nextOrder = (maxRow?.m ?? -1) + 1
  getDb().prepare(
    'INSERT INTO project_workspaces (id, name, color, sort_order, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, input.name, input.color ?? null, nextOrder, now)
  return { id, name: input.name, color: input.color ?? null, sort_order: nextOrder, created_at: now }
}

export function renameWorkspace(id: string, name: string): void {
  getDb().prepare('UPDATE project_workspaces SET name = ? WHERE id = ?').run(name, id)
}

export function recolorWorkspace(id: string, color: string | null): void {
  getDb().prepare('UPDATE project_workspaces SET color = ? WHERE id = ?').run(color, id)
}

export function deleteWorkspace(id: string): void {
  // ON DELETE SET NULL on projects.workspace_id moves orphans to Ungrouped.
  getDb().prepare('DELETE FROM project_workspaces WHERE id = ?').run(id)
}

export function reorderWorkspaces(orderedIds: string[]): void {
  const db = getDb()
  const stmt = db.prepare('UPDATE project_workspaces SET sort_order = ? WHERE id = ?')
  db.transaction(() => {
    orderedIds.forEach((id, i) => stmt.run(i, id))
  })()
}

export function setProjectWorkspace(projectPath: string, workspaceId: string | null): void {
  getDb().prepare('UPDATE projects SET workspace_id = ? WHERE path = ?').run(workspaceId, projectPath)
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
  /** ID of the source conversation a fork was spun from. Null for native conversations. */
  parent_conversation_id?: string | null
  /** ID of the source message the fork was anchored at. Null for non-forks. */
  forked_at_message_id?: string | null
  /** Absolute path to the git worktree backing this conversation. Null if the
   *  fork did not opt into a worktree (or this is not a fork at all). */
  worktree_path?: string | null
  /** Branch checked out in the fork's worktree (e.g. `fork/fix-redis-timeout`).
   *  Null when `worktree_path` is null. */
  worktree_branch?: string | null
}

/**
 * Insert a conversation row that records its fork lineage. Mirrors
 * `createConversation` but writes the parent + anchor columns added in
 * the fork-from-message migration. Used by `forkConversation` in
 * `src/main/conversations/fork.ts`.
 */
export function createForkedConversation(args: {
  id: string
  projectPath: string
  agentType: string
  title: string
  parentConversationId: string
  forkedAtMessageId: string
  sessionId?: string | null
  /** Set together with `worktreeBranch` when the fork was created with
   *  `withWorktree: true`. Both null otherwise. */
  worktreePath?: string | null
  worktreeBranch?: string | null
}): void {
  const now = Date.now()
  getDb().prepare(
    `INSERT INTO conversations (
       id, project_path, agent_type, session_id, title,
       created_at, updated_at,
       parent_conversation_id, forked_at_message_id,
       worktree_path, worktree_branch
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    args.id, args.projectPath, args.agentType,
    args.sessionId ?? null, args.title,
    now, now,
    args.parentConversationId, args.forkedAtMessageId,
    args.worktreePath ?? null, args.worktreeBranch ?? null,
  )
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

/**
 * Per-conversation runtime mode (plan/sandbox/accept-edits/full-access).
 * Returns null if never set. Callers should fall back to a user default.
 */
export function getConversationRuntimeMode(id: string): string | null {
  const row = getDb().prepare(
    'SELECT runtime_mode FROM conversations WHERE id = ?'
  ).get(id) as { runtime_mode: string | null } | undefined
  return row?.runtime_mode ?? null
}

/**
 * Persist the per-conversation runtime mode. Called when the user picks a
 * mode in the chat header so reopening the conversation (incl. via a kanban
 * card click) restores their selection instead of resetting to 'sandbox'.
 */
export function setConversationRuntimeMode(id: string, mode: string): void {
  getDb().prepare(
    'UPDATE conversations SET runtime_mode = ?, updated_at = ? WHERE id = ?'
  ).run(mode, Date.now(), id)
}

/**
 * Per-conversation provider instance id. Returns null if the column was
 * not yet populated (extremely old conversation, or one created before
 * the multi-instance migration ran). Callers fall back to the
 * `<agentType>-default` instance.
 */
export function getConversationProviderInstanceId(id: string): string | null {
  const row = getDb().prepare(
    'SELECT provider_instance_id FROM conversations WHERE id = ?'
  ).get(id) as { provider_instance_id: string | null } | undefined
  return row?.provider_instance_id ?? null
}

export function setConversationProviderInstanceId(id: string, instanceId: string): void {
  getDb().prepare(
    'UPDATE conversations SET provider_instance_id = ?, updated_at = ? WHERE id = ?'
  ).run(instanceId, Date.now(), id)
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
  displayBody?: string,
  pillsMeta?: string,
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
    `INSERT OR REPLACE INTO messages
       (id, conversation_id, role, content, tool_calls, images, timestamp, display_body, pills_meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, conversationId, role, content,
    toolCalls ?? null, images ?? null, now,
    displayBody ?? null, pillsMeta ?? null,
  )

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
  display_body: string | null
  pills_meta: string | null
}

export function getMessagesForConversation(conversationId: string): MessageRow[] {
  return getDb().prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC'
  ).all(conversationId) as MessageRow[]
}

/** Pill enrichments for user messages, keyed by content. See
 *  `enrichMessagesWithDisplayBody` for the content-match rationale. */
export interface DisplayBodyEnrichment {
  displayBody: string
  pillsMeta: string
}
export function getDisplayBodyEnrichments(
  conversationId: string,
): Map<string, DisplayBodyEnrichment> {
  const rows = getDb().prepare(
    `SELECT content, display_body, pills_meta
       FROM messages
      WHERE conversation_id = ?
        AND role = 'user'
        AND display_body IS NOT NULL`
  ).all(conversationId) as Array<{ content: string; display_body: string; pills_meta: string | null }>
  const out = new Map<string, DisplayBodyEnrichment>()
  for (const r of rows) {
    out.set(r.content, {
      displayBody: r.display_body,
      pillsMeta: r.pills_meta ?? '{}',
    })
  }
  return out
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

export interface StoredSessionLayout {
  layoutJson: string
  /** Name of the workspace template this layout was hydrated from. */
  templateName: string | null
}

export function saveSessionLayout(
  sessionId: string,
  layoutJson: string,
  templateName?: string | null,
): void {
  getDb().prepare(
    'INSERT OR REPLACE INTO session_layouts (session_id, layout_json, template_name, updated_at) VALUES (?, ?, ?, ?)'
  ).run(sessionId, layoutJson, templateName ?? null, Date.now())
}

export function getSessionLayout(sessionId: string): StoredSessionLayout | null {
  const row = getDb().prepare(
    'SELECT layout_json, template_name FROM session_layouts WHERE session_id = ?'
  ).get(sessionId) as { layout_json: string; template_name: string | null } | undefined
  if (!row) return null
  return { layoutJson: row.layout_json, templateName: row.template_name }
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
  if (raw === 'plan' || raw === 'sandbox' || raw === 'accept-edits' || raw === 'full-access') {
    return raw
  }
  return KANBAN_DEFAULT_RUNTIME_MODE
}

function rowToCard(r: KanbanRow): KanbanCard {
  let tags: string[] = []
  try { const parsed = JSON.parse(r.tags); if (Array.isArray(parsed)) tags = parsed.map(String) } catch { /* malformed — show as empty */ }
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
    VALUES (?, ?, ?, ?, ?, 'backlog', ?, ?)
  `).run(id, input.projectPath, input.title, input.description ?? '', tagsJson, input.costCapUsd ?? null, runtimeMode)
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
  const rows = getDb().prepare(
    'SELECT worktree_path FROM kanban_cards WHERE project_path = ? AND worktree_path IS NOT NULL'
  ).all(projectPath) as Array<{ worktree_path: string }>
  return new Set(rows.map((r) => r.worktree_path))
}
