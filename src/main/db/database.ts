import Database from 'better-sqlite3'
import { userDataDir } from '../runtime'
import { join } from 'path'
import { existsSync, mkdirSync, renameSync } from 'fs'
import { createMainLogger as createLogger } from '../logger'
import type { KanbanCard, KanbanCardCreate, KanbanCardUpdate, KanbanStatus } from '@shared/kanban'
import { KANBAN_DEFAULT_RUNTIME_MODE } from '@shared/kanban'
import { applyKanbanArchiveSideEffect } from '@shared/kanbanArchive'
import type { RuntimeMode } from '@shared/provider-events'
import { AGENT_TYPES, defaultInstanceId } from '@shared/types'
import type { ChatMessage } from '@shared/types'
import type { ProjectOrganizationItem } from '@shared/types'
import { deriveProjectPositions } from './projectOrdering'
import type { ConversationSidebarRole } from './conversationSidebarRole'
import { ensureTurnAcceptanceSchema, recoverUndispatchedTurns } from './turn-acceptance'

const log = createLogger('db')

let db: Database.Database | null = null

function getDbPath(): string {
  const dbDir = join(userDataDir(), 'data')
  mkdirSync(dbDir, { recursive: true })
  return join(dbDir, 'switchboard.db')
}

export function getDb(): Database.Database {
  if (db) return db

  const dbPath = getDbPath()
  log.info(`opening database: ${dbPath}`)

  try {
    db = openAndMigrate(dbPath)
  } catch (err) {
    // A native binding that will not load says NOTHING about the database file.
    // Moving it aside here destroyed a perfectly good DB whenever
    // better-sqlite3 was built for a different ABI than the running runtime -
    // e.g. `npm run rebuild` targets Electron (module version 130) while the
    // headless server runs under system node (137). Fail loudly with the fix
    // instead of eating the data.
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ERR_DLOPEN_FAILED' || code === 'MODULE_NOT_FOUND') {
      log.error(`better-sqlite3 could not load - NOT touching ${dbPath}`, err)
      throw new Error(
        'better-sqlite3 failed to load: it was built for a different runtime than the one ' +
          'running now. For the Electron app run `npm run rebuild`; for the headless server ' +
          'run it under Electron as node (`npm run server`) or rebuild for plain node.',
      )
    }
    if (code !== 'SQLITE_CORRUPT' && code !== 'SQLITE_NOTADB') {
      log.error(`database initialization failed - NOT touching ${dbPath}`, err)
      throw err
    }
    // Only SQLite's explicit corruption codes justify moving the database.
    // Migration, permission, I/O, and configuration failures must leave it in
    // place so a corrected build can retry without turning an app bug into
    // apparent data loss.
    log.error(`database open failed, moving aside and recreating: ${dbPath}`, err)
    const backup = `${dbPath}.corrupt-${Date.now()}`
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        if (existsSync(dbPath + suffix)) renameSync(dbPath + suffix, backup + suffix)
      } catch (moveErr) {
        log.warn(`could not move aside ${dbPath}${suffix}`, moveErr)
      }
    }
    // If even a fresh DB fails (disk full, dir unwritable) this throws -
    // genuinely fatal, surfaced by the caller.
    db = openAndMigrate(dbPath)
    notifyDbReset(backup)
  }
  return db
}

function openAndMigrate(dbPath: string): Database.Database {
  const d = new Database(dbPath)
  d.pragma('journal_mode = WAL')
  d.pragma('foreign_keys = ON')
  migrate(d)
  return d
}

function notifyDbReset(backupPath: string): void {
  try {
    // Lazy require - unit tests import this module outside Electron.
    const { dialog } = require('electron') as typeof import('electron')
    dialog.showErrorBox(
      'Switchboard database was reset',
      `The local database could not be opened, so it was moved to:\n${backupPath}\n\nA fresh database was created. Provider session files are still available through Import conversations in the sidebar.`,
    )
  } catch (dialogErr) {
    log.warn('could not show DB-reset dialog', dialogErr)
  }
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      path TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      added_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      sort_order INTEGER NOT NULL DEFAULT 0
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
    // Migration: pill-aware display body for sent user messages - see
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
    // getArchivedConversationIds() runs on every sidebar scan / project
    // expand; without an index leading on `archived` it full-scans the
    // conversations table each time. Partial index keeps it tiny (only
    // archived rows are indexed).
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_archived ON conversations(archived) WHERE archived = 1;')
    // Migration (2026-05-04): persist the per-conversation runtime mode
    // (plan / sandbox / accept-edits / full-access) so reopening a chat -
    // especially via a kanban card click - restores the user's actual
    // selection instead of falling back to the hardcoded 'sandbox' default.
    if (!cols.some((c) => c.name === 'runtime_mode')) {
      db.exec('ALTER TABLE conversations ADD COLUMN runtime_mode TEXT')
    }
    // Migration (#4 - fork-from-message): record fork lineage so the
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
    // Migration (#5 - fork-to-worktree): when the user opts a fork into
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
    // Migration (2026-08-01 - shared read state): epoch ms of the last time any
    // client marked this thread read. Nullable: a never-opened conversation has
    // no read point, and null is not the same as "read at time 0".
    if (!cols.some((c) => c.name === 'last_read_at')) {
      db.exec('ALTER TABLE conversations ADD COLUMN last_read_at INTEGER')
    }
    if (!cols.some((c) => c.name === 'sidebar_role')) {
      db.exec("ALTER TABLE conversations ADD COLUMN sidebar_role TEXT")
    }
  } catch { /* ignore */ }

  // Migration (v0.1.20): track which launch config a session hydrated
  // from, so the per-chat picker can show the correct current selection
  // and so hot-reloads of launch-config.yaml know which named config to
  // respawn. Originally added as `template_name`; renamed to
  // `launch_config_name` when the feature moved off the old "workspace"/
  // "template" names. We rename the existing column in place so pinned
  // selections survive the upgrade.
  try {
    const cols = db.prepare("PRAGMA table_info(session_layouts)").all() as Array<{ name: string }>
    const hasNew = cols.some((c) => c.name === 'launch_config_name')
    const hasOld = cols.some((c) => c.name === 'template_name')
    if (!hasNew && hasOld) {
      db.exec('ALTER TABLE session_layouts RENAME COLUMN template_name TO launch_config_name')
    } else if (!hasNew) {
      db.exec('ALTER TABLE session_layouts ADD COLUMN launch_config_name TEXT')
    }
  } catch { /* ignore */ }

  // ─── Workspaces (outer sidebar grouping above projects) ──────────
  // A project belongs to at most one workspace via the nullable
  // `workspace_id` FK. ON DELETE SET NULL means deleting a workspace
  // returns its projects to the implicit "Ungrouped" pseudo-bucket
  // - never destroys data.
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
    if (!cols.some((c) => c.name === 'sort_order')) {
      db.exec('ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0')
      const saved = db.prepare("SELECT value FROM settings WHERE key = 'projectOrder'").get() as { value: string } | undefined
      let savedOrder: string[] | null = null
      if (saved?.value) {
        try { savedOrder = JSON.parse(saved.value) } catch { savedOrder = null }
      }
      const rows = db.prepare(
        'SELECT path, workspace_id, added_at FROM projects'
      ).all() as Array<{ path: string; workspace_id: string | null; added_at: number }>
      const positions = deriveProjectPositions(
        rows.map((row) => ({ path: row.path, workspaceId: row.workspace_id, addedAt: row.added_at })),
        savedOrder,
      )
      const update = db.prepare('UPDATE projects SET sort_order = ? WHERE path = ?')
      db.transaction(() => {
        positions.forEach((position) => update.run(position.sortOrder, position.path))
      })()
    }
  } catch (error) {
    log.warn('project organization migration failed', error)
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);')
  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_workspace_order ON projects(workspace_id, sort_order);')

  // Thread ancestry - Claude's SDK can reassign `session_id` mid-conversation
  // (compaction, fork, restart), producing multiple .jsonl files for what the
  // user sees as one chat. This table maps each child session_id to its
  // root thread id (the stable id the user renamed, archived, etc.).
  //
  // Pattern borrowed from T3 Code's `projection_thread_sessions` spec -
  // "never overload orchestration thread id as Claude thread id."
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_sessions (
      claude_session_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      recorded_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_thread_sessions_thread ON thread_sessions(thread_id);

    CREATE TABLE IF NOT EXISTS conversation_segments (
      id                   TEXT PRIMARY KEY,
      conversation_id      TEXT NOT NULL,
      provider             TEXT NOT NULL,
      provider_session_id  TEXT NOT NULL,
      provider_instance_id TEXT,
      ordinal              INTEGER NOT NULL,
      created_at           INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at           INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      UNIQUE(conversation_id, provider, provider_session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_segments_order
      ON conversation_segments(conversation_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_conversation_segments_resume
      ON conversation_segments(conversation_id, provider, provider_instance_id, ordinal DESC);
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
  } catch { /* best-effort - flattening can be re-run on next launch */ }

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

  ensureBookmarksTable(db)

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

  // Migration (2026-07-10): plaintext env key NAMES (JSON array) so LIST can
  // show which vars an instance sets WITHOUT decrypting env_encrypted.
  // Decrypting on LIST hit the macOS Keychain at every app boot, and on an
  // unsigned build that means a password prompt on every launch. Key names
  // are not secrets; values stay encrypted. Backfilled on next upsert.
  const piCols = db.prepare("PRAGMA table_info(provider_instances)").all() as Array<{ name: string }>
  if (!piCols.some((c) => c.name === 'env_keys')) {
    db.exec('ALTER TABLE provider_instances ADD COLUMN env_keys TEXT')
  }

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

  // Migration (2026-08-06): persist the per-conversation pinned model, same
  // shape as runtime_mode/provider_instance_id above. Previously the pick
  // lived only on the in-memory AgentSession, so it was lost the moment a
  // chat's live session object stopped matching the id the sidebar/kanban
  // handed back (e.g. after Claude assigns the chat its own session id).
  if (!convCols.some((c) => c.name === 'model')) {
    db.exec('ALTER TABLE conversations ADD COLUMN model TEXT')
  }

  // Migration (2026-08-08): provider of a scheduled cross-provider context
  // handoff. Set on an agent switch over existing history (and on degraded
  // Codex / OpenCode forks); consumed and cleared when the next turn gets
  // the transcript preamble prefixed. Same shape as runtime_mode above.
  if (!convCols.some((c) => c.name === 'pending_handoff_from')) {
    db.exec('ALTER TABLE conversations ADD COLUMN pending_handoff_from TEXT')
  }

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
  } catch { /* FTS rebuild failed - not critical */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS machines (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      ssh_alias   TEXT,
      ssh_host    TEXT NOT NULL,
      ssh_user    TEXT,
      ssh_port    INTEGER NOT NULL DEFAULT 22,
      remote_user TEXT,
      transport_kind TEXT NOT NULL DEFAULT 'ssh',
      iap_instance TEXT,
      iap_project  TEXT,
      iap_zone     TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_machines_sort ON machines(sort_order);

    CREATE TABLE IF NOT EXISTS machine_snapshots (
      machine_id TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      synced_at  INTEGER NOT NULL
    );
  `)

  const machineCols = db.prepare('PRAGMA table_info(machines)').all() as Array<{ name: string }>
  if (!machineCols.some((c) => c.name === 'remote_user')) {
    db.exec('ALTER TABLE machines ADD COLUMN remote_user TEXT')
  }
  if (!machineCols.some((c) => c.name === 'transport_kind')) {
    db.exec("ALTER TABLE machines ADD COLUMN transport_kind TEXT NOT NULL DEFAULT 'ssh'")
  }
  if (!machineCols.some((c) => c.name === 'iap_instance')) {
    db.exec('ALTER TABLE machines ADD COLUMN iap_instance TEXT')
  }
  if (!machineCols.some((c) => c.name === 'iap_project')) {
    db.exec('ALTER TABLE machines ADD COLUMN iap_project TEXT')
  }
  if (!machineCols.some((c) => c.name === 'iap_zone')) {
    db.exec('ALTER TABLE machines ADD COLUMN iap_zone TEXT')
  }

  // Rows created before managed-root projection may have come from the raw
  // filesystem scanner. Keep only rows with durable app-owned evidence in the
  // normal sidebar; everything else remains intact and recoverable.
  db.exec(`
    UPDATE conversations
    SET sidebar_role = CASE
      WHEN id GLOB 'agent_*' THEN 'managed'
      WHEN EXISTS (SELECT 1 FROM messages WHERE messages.conversation_id = conversations.id) THEN 'managed'
      WHEN EXISTS (SELECT 1 FROM conversation_segments WHERE conversation_segments.conversation_id = conversations.id) THEN 'managed'
      WHEN forked_at_message_id IS NOT NULL THEN 'managed'
      WHEN EXISTS (SELECT 1 FROM thread_sessions WHERE thread_sessions.thread_id = conversations.id) THEN 'managed'
      WHEN EXISTS (SELECT 1 FROM kanban_cards WHERE kanban_cards.conversation_id = conversations.id) THEN 'managed'
      WHEN EXISTS (SELECT 1 FROM bookmarks WHERE bookmarks.session_id = conversations.id) THEN 'managed'
      ELSE 'recovery'
    END
    WHERE sidebar_role IS NULL;
    CREATE INDEX IF NOT EXISTS idx_conversations_sidebar_roots
      ON conversations(project_path, updated_at DESC)
      WHERE sidebar_role = 'managed' AND archived = 0;
  `)

  ensureTurnAcceptanceSchema(db)
  recoverUndispatchedTurns(db)

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
    `INSERT OR IGNORE INTO projects (path, name, sort_order)
     SELECT ?, ?, COALESCE(MAX(sort_order), -1) + 1
       FROM projects
      WHERE workspace_id IS NULL`
  ).run(path, name)
}

export function getProjects(): Array<{ path: string; name: string; added_at: number; workspace_id: string | null; sort_order: number }> {
  return getDb().prepare(
    `SELECT p.path, p.name, p.added_at, p.workspace_id, p.sort_order
       FROM projects p
       LEFT JOIN project_workspaces w ON w.id = p.workspace_id
      ORDER BY CASE WHEN p.workspace_id IS NULL THEN 1 ELSE 0 END,
               w.sort_order ASC,
               p.sort_order ASC,
               p.added_at DESC,
               p.path ASC`
  ).all() as Array<{
    path: string
    name: string
    added_at: number
    workspace_id: string | null
    sort_order: number
  }>
}

export function removeProject(path: string): void {
  const db = getDb()
  db.transaction(() => {
    const row = db.prepare('SELECT workspace_id FROM projects WHERE path = ?')
      .get(path) as { workspace_id: string | null } | undefined
    db.prepare('DELETE FROM projects WHERE path = ?').run(path)
    if (row) normalizeProjectGroup(db, row.workspace_id)
  })()
}

export function renameProject(path: string, name: string): void {
  getDb().prepare('UPDATE projects SET name = ? WHERE path = ?').run(name, path)
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
  const db = getDb()
  const paths = (sql: string, ...args: unknown[]) => (
    db.prepare(sql).all(...args) as Array<{ path: string }>
  ).map((row) => row.path)
  db.transaction(() => {
    const ungrouped = paths(
      'SELECT path FROM projects WHERE workspace_id IS NULL ORDER BY sort_order, added_at DESC, path'
    )
    const moving = paths(
      'SELECT path FROM projects WHERE workspace_id = ? ORDER BY sort_order, added_at DESC, path',
      id,
    )
    db.prepare('DELETE FROM project_workspaces WHERE id = ?').run(id)
    const update = db.prepare('UPDATE projects SET sort_order = ? WHERE path = ?')
    const reordered = [...ungrouped, ...moving]
    reordered.forEach((path, index) => update.run(index, path))
  })()
}

export function reorderWorkspaces(orderedIds: string[]): void {
  const db = getDb()
  const stmt = db.prepare('UPDATE project_workspaces SET sort_order = ? WHERE id = ?')
  db.transaction(() => {
    orderedIds.forEach((id, i) => stmt.run(i, id))
  })()
}

export function setProjectWorkspace(projectPath: string, workspaceId: string | null): void {
  const db = getDb()
  db.transaction(() => {
    const current = db.prepare('SELECT workspace_id FROM projects WHERE path = ?')
      .get(projectPath) as { workspace_id: string | null } | undefined
    if (!current || current.workspace_id === workspaceId) return
    const max = db.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) AS value FROM projects WHERE workspace_id IS ?'
    ).get(workspaceId) as { value: number }
    db.prepare('UPDATE projects SET workspace_id = ?, sort_order = ? WHERE path = ?')
      .run(workspaceId, max.value + 1, projectPath)
    normalizeProjectGroup(db, current.workspace_id)
    normalizeProjectGroup(db, workspaceId)
  })()
}

function normalizeProjectGroup(database: Database.Database, workspaceId: string | null): void {
  const rows = database.prepare(
    'SELECT path FROM projects WHERE workspace_id IS ? ORDER BY sort_order, added_at DESC, path'
  ).all(workspaceId) as Array<{ path: string }>
  const update = database.prepare('UPDATE projects SET sort_order = ? WHERE path = ?')
  rows.forEach((row, index) => update.run(index, row.path))
}

export function organizeProjects(items: ProjectOrganizationItem[]): void {
  const db = getDb()
  db.transaction(() => {
    const existing = db.prepare('SELECT path FROM projects').all() as Array<{ path: string }>
    const requested = new Set(items.map((item) => item.path))
    if (requested.size !== items.length || existing.length !== items.length || existing.some((row) => !requested.has(row.path))) {
      throw new Error('Project list changed while it was being reordered')
    }
    const workspaceIds = new Set(
      (db.prepare('SELECT id FROM project_workspaces').all() as Array<{ id: string }>).map((row) => row.id),
    )
    if (items.some((item) => item.workspaceId !== null && !workspaceIds.has(item.workspaceId))) {
      throw new Error('A target workspace no longer exists')
    }
    const nextByWorkspace = new Map<string | null, number>()
    const update = db.prepare(
      'UPDATE projects SET workspace_id = ?, sort_order = ? WHERE path = ?'
    )
    items.forEach((item) => {
      const sortOrder = nextByWorkspace.get(item.workspaceId) ?? 0
      nextByWorkspace.set(item.workspaceId, sortOrder + 1)
      update.run(item.workspaceId, sortOrder, item.path)
    })
  })()
}

// ─── Conversation CRUD ──────────────────────────────────────────

export function createConversation(
  id: string,
  projectPath: string,
  agentType: string,
  title?: string,
  worktreePath?: string | null,
  worktreeBranch?: string | null,
): boolean {
  const now = Date.now()
  const info = getDb().prepare(
    `INSERT OR IGNORE INTO conversations (id, project_path, agent_type, title, created_at, updated_at, worktree_path, worktree_branch, sidebar_role)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'managed')`
  ).run(
    id,
    projectPath,
    agentType,
    title ?? 'New conversation',
    now,
    now,
    worktreePath ?? null,
    worktreeBranch ?? null,
  )
  return info.changes > 0
}

export function promoteConversationToManaged(
  id: string,
  projectPath: string,
  agentType: string,
  title: string,
): void {
  const database = getDb()
  createConversation(id, projectPath, agentType, title)
  database.prepare(
    `UPDATE conversations
     SET sidebar_role = 'managed', archived = 0, agent_type = ?, title = ?,
         session_id = COALESCE(session_id, ?), updated_at = ?
     WHERE id = ? AND project_path = ?`
  ).run(agentType, title, id, Date.now(), id, projectPath)
}

export type RecoveryReviveResult = 'revived' | 'missing' | 'project-mismatch'

/** Restore an existing logical conversation without changing how it resumes. */
export function reviveConversationForRecovery(
  id: string,
  projectPath: string,
  title: string,
): RecoveryReviveResult {
  const database = getDb()
  const existing = database.prepare(
    'SELECT project_path FROM conversations WHERE id = ?'
  ).get(id) as { project_path: string } | undefined
  if (!existing) return 'missing'
  if (existing.project_path !== projectPath) return 'project-mismatch'
  const result = database.prepare(
    `UPDATE conversations
     SET sidebar_role = 'managed', archived = 0, title = ?, updated_at = ?
     WHERE id = ? AND project_path = ?`
  ).run(title, Date.now(), id, projectPath)
  return result.changes > 0 ? 'revived' : 'missing'
}

export function getRecoveryConversationTitles(nativeSessionId: string): {
  nativeTitle: string | null
  rootTitle: string | null
} {
  const database = getDb()
  const native = database.prepare(
    'SELECT title FROM conversations WHERE id = ?'
  ).get(nativeSessionId) as { title: string } | undefined
  const rootId = resolveRootThreadId(nativeSessionId)
  const root = rootId === nativeSessionId
    ? native
    : database.prepare('SELECT title FROM conversations WHERE id = ?')
      .get(rootId) as { title: string } | undefined
  return {
    nativeTitle: native?.title ?? null,
    rootTitle: root?.title ?? null,
  }
}

/**
 * Update the worktree pointer on an existing conversation. Used by the
 * branch picker when the user picks a branch that already has a
 * worktree on disk.
 */
export function setConversationWorktree(
  id: string,
  worktreePath: string | null,
  worktreeBranch: string | null,
): void {
  getDb().prepare(
    `UPDATE conversations SET worktree_path = ?, worktree_branch = ?, updated_at = ? WHERE id = ?`
  ).run(worktreePath, worktreeBranch, Date.now(), id)
}

export function updateConversationSessionId(id: string, sessionId: string): void {
  getDb().prepare(
    'UPDATE conversations SET session_id = ?, updated_at = ? WHERE id = ?'
  ).run(sessionId, Date.now(), id)
}

/** Returns false when the title was already this, so callers can skip a broadcast. */
export function updateConversationTitle(id: string, title: string): boolean {
  const info = getDb().prepare(
    'UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND title IS NOT ?'
  ).run(title, Date.now(), id, title)
  return info.changes > 0
}

/**
 * One conversation's display title, or null when no row exists.
 *
 * Resolves through `resolveRootThreadId` for the same reason as the
 * per-conversation settings below: a caller holding Claude's rotated session
 * UUID would otherwise read nothing and label the chat with a raw id.
 */
export function getConversationTitle(id: string): string | null {
  const row = getDb().prepare(
    'SELECT title FROM conversations WHERE id = ?'
  ).get(resolveRootThreadId(id)) as { title: string } | undefined
  return row?.title ?? null
}

export function getConversationsForProject(projectPath: string): ConversationRow[] {
  return getDb().prepare(
    'SELECT * FROM conversations WHERE project_path = ? ORDER BY updated_at DESC'
  ).all(projectPath) as ConversationRow[]
}

const MANAGED_ROOT_PREDICATE = `
  c.sidebar_role = 'managed' AND c.archived = 0
  AND NOT EXISTS (
    SELECT 1
    FROM thread_sessions ts
    JOIN conversations root ON root.id = ts.thread_id
    WHERE ts.claude_session_id = c.id
      AND ts.thread_id != c.id
      AND root.sidebar_role = 'managed'
  )
`

export function getManagedRootConversationsForProject(projectPath: string): ConversationRow[] {
  return getDb().prepare(
    `SELECT c.* FROM conversations c
     WHERE c.project_path = ? AND ${MANAGED_ROOT_PREDICATE}
     ORDER BY c.updated_at DESC`
  ).all(projectPath) as ConversationRow[]
}

export function getManagedRootConversationsForProjects(projectPaths: string[]): Map<string, ConversationRow[]> {
  const result = new Map<string, ConversationRow[]>()
  for (const path of projectPaths) result.set(path, [])
  const database = getDb()
  const chunkSize = 500
  for (let offset = 0; offset < projectPaths.length; offset += chunkSize) {
    const chunk = projectPaths.slice(offset, offset + chunkSize)
    const placeholders = chunk.map(() => '?').join(',')
    const rows = database.prepare(
      `SELECT c.* FROM conversations c
       WHERE c.project_path IN (${placeholders}) AND ${MANAGED_ROOT_PREDICATE}
       ORDER BY c.updated_at DESC`
    ).all(...chunk) as ConversationRow[]
    for (const row of rows) result.get(row.project_path)?.push(row)
  }
  return result
}

/**
 * Batched variant of getConversationsForProject: one IN query for all
 * projects instead of one query per project (GET_PROJECTS runs on every
 * sidebar / settings / kanban refresh). Every requested path is present in
 * the result, mapped to [] when it has no conversations. Per-project row
 * order matches getConversationsForProject (updated_at DESC).
 */
export function getConversationsForProjects(projectPaths: string[]): Map<string, ConversationRow[]> {
  const result = new Map<string, ConversationRow[]>()
  for (const p of projectPaths) result.set(p, [])
  const db = getDb()
  const CHUNK = 500 // stay well under SQLite's bound-parameter cap
  for (let i = 0; i < projectPaths.length; i += CHUNK) {
    const chunk = projectPaths.slice(i, i + CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT * FROM conversations WHERE project_path IN (${placeholders}) ORDER BY updated_at DESC`
    ).all(...chunk) as ConversationRow[]
    for (const row of rows) result.get(row.project_path)?.push(row)
  }
  return result
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
  sidebar_role?: ConversationSidebarRole | null
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
       worktree_path, worktree_branch, sidebar_role
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'managed')`
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
 * FLATTENS the chain on insert - if `threadId` is itself a child of some
 * deeper root, we resolve to that root first. And if `claudeSessionId`
 * already has descendants, we re-parent them too. Result: the table
 * always stores a two-level relationship (leaf → ultimate root), never
 * chains like `A → B → C`.
 *
 * Without flattening, `listSessionIdsForThread(C)` would miss A because
 * A's direct parent is B, not C.
 */
export function recordThreadSession(claudeSessionId: string, threadId: string): void {
  if (claudeSessionId === threadId) return // self-reference - nothing to track
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
 * parent chain until it hits a terminal (no row) - handles legacy rows
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
/**
 * Every conversation id one thread answers to: root plus rotated session ids.
 * Per-thread WRITES need all of them, since a rotated chat owns a row per id
 * and updating one leaves the rest stale. Reads can use `resolveRootThreadId`.
 */
export function threadFamilyIds(id: string): string[] {
  return listSessionIdsForThread(resolveRootThreadId(id))
}

/** Native-session ids persisted before typed segments shipped. */
export function conversationSessionHints(id: string): string[] {
  const familyIds = threadFamilyIds(id)
  const hints: string[] = []
  const seen = new Set<string>()
  const stmt = getDb().prepare('SELECT session_id FROM conversations WHERE id = ?')
  for (const familyId of familyIds) {
    const row = stmt.get(familyId) as { session_id: string | null } | undefined
    if (!row?.session_id || seen.has(row.session_id)) continue
    seen.add(row.session_id)
    hints.push(row.session_id)
  }
  return hints
}

export function listSessionIdsForThread(threadId: string): string[] {
  const db = getDb()
  const directStmt = db.prepare(
    'SELECT claude_session_id, recorded_at FROM thread_sessions WHERE thread_id = ? ORDER BY recorded_at ASC'
  )
  const result: string[] = [threadId]
  const visited = new Set<string>([threadId])
  // BFS - each queued id's direct children are added. With flattening
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

export type ConversationSegmentProvider = 'claude-code' | 'codex' | 'opencode'

export interface ConversationSegmentRow {
  id: string
  conversation_id: string
  provider: ConversationSegmentProvider
  provider_session_id: string
  provider_instance_id: string | null
  ordinal: number
  created_at: number
  updated_at: number
}

export function recordConversationSegment(input: {
  conversationId: string
  provider: ConversationSegmentProvider
  providerSessionId: string
  providerInstanceId?: string | null
}): void {
  const database = getDb()
  const conversationId = resolveRootThreadId(input.conversationId)
  const now = Date.now()
  database.transaction(() => {
    const existing = database.prepare(
      `SELECT id FROM conversation_segments
       WHERE conversation_id = ? AND provider = ? AND provider_session_id = ?`
    ).get(conversationId, input.provider, input.providerSessionId) as { id: string } | undefined
    if (existing) {
      database.prepare(
        `UPDATE conversation_segments
         SET provider_instance_id = COALESCE(?, provider_instance_id), updated_at = ?
         WHERE id = ?`
      ).run(input.providerInstanceId ?? null, now, existing.id)
      return
    }
    const next = database.prepare(
      'SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM conversation_segments WHERE conversation_id = ?'
    ).get(conversationId) as { ordinal: number }
    database.prepare(
      `INSERT INTO conversation_segments (
         id, conversation_id, provider, provider_session_id,
         provider_instance_id, ordinal, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `${conversationId}:${input.provider}:${input.providerSessionId}`,
      conversationId,
      input.provider,
      input.providerSessionId,
      input.providerInstanceId ?? null,
      next.ordinal,
      now,
      now,
    )
  })()
}

export function listConversationSegments(conversationId: string): ConversationSegmentRow[] {
  return getDb().prepare(
    `SELECT * FROM conversation_segments
     WHERE conversation_id = ? ORDER BY ordinal ASC, created_at ASC`
  ).all(resolveRootThreadId(conversationId)) as ConversationSegmentRow[]
}

/** Resolve an explicitly managed root that already owns a native session.
 * `promotedOnly` keeps a delegated run from resolving to its original parent;
 * promotion is a new root and is idempotent on subsequent imports. */
export function findManagedConversationForNativeSession(
  provider: ConversationSegmentProvider,
  providerSessionId: string,
  promotedOnly = false,
): string | null {
  const row = getDb().prepare(
    `SELECT c.id
     FROM conversation_segments s
     JOIN conversations c ON c.id = s.conversation_id
     WHERE s.provider = ? AND s.provider_session_id = ?
       AND c.sidebar_role = 'managed'
       AND (? = 0 OR c.id LIKE 'import\_%' ESCAPE '\')
     ORDER BY s.ordinal DESC
     LIMIT 1`
  ).get(provider, providerSessionId, promotedOnly ? 1 : 0) as { id: string } | undefined
  return row?.id ?? null
}

export function resolveResumeSegment(
  conversationId: string,
  provider: ConversationSegmentProvider,
  providerInstanceId?: string | null,
): ConversationSegmentRow | null {
  return selectResumeSegment(listConversationSegments(conversationId), provider, providerInstanceId)
}

export function selectResumeSegment(
  segments: readonly ConversationSegmentRow[],
  provider: ConversationSegmentProvider,
  providerInstanceId?: string | null,
): ConversationSegmentRow | null {
  let providerFallback: ConversationSegmentRow | null = null
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]
    if (segment.provider !== provider) continue
    providerFallback ??= segment
    if (!providerInstanceId || segment.provider_instance_id === providerInstanceId) return segment
  }
  return providerFallback
}

/**
 * Returns the set of claude_session_ids that are CHILDREN of some other
 * thread - used to hide fragmented .jsonl files from the sidebar scanner.
 *
 * IMPORTANT: Only hide UUIDs whose parent is ALSO a real UUID (i.e. has
 * its own .jsonl on disk). If the parent is a synthetic `agent_<ts>` ID
 * (Switchboard-native, never written to disk), hiding the UUID would make
 * the whole chat invisible - the synthetic parent has no scanner entry to
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
 * Dump all ancestry rows - used for debugging via the devtools console.
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
 *
 * Resolves `id` through `resolveRootThreadId` first: the sidebar hands back
 * whatever id the disk scanner currently considers canonical for this chat,
 * which is the Claude UUID once one has been assigned - but the mode was
 * saved against the synthetic `agent_<ts>` id this chat was created under.
 * Without this, every conversation "forgot" its runtime mode (and provider
 * instance, below) the first time it was reopened after Claude assigned it
 * a session id, since the raw id used to save it isn't the one being read
 * back. `resolveRootThreadId` no-ops when `id` was never rotated.
 */
export function getConversationRuntimeMode(id: string): string | null {
  const row = getDb().prepare(
    'SELECT runtime_mode FROM conversations WHERE id = ?'
  ).get(resolveRootThreadId(id)) as { runtime_mode: string | null } | undefined
  return row?.runtime_mode ?? null
}

/**
 * Persist the per-conversation runtime mode. Called when the user picks a
 * mode in the chat header so reopening the conversation (incl. via a kanban
 * card click) restores their selection instead of resetting to 'sandbox'.
 *
 * Resolves through `resolveRootThreadId` for the same reason as the getter
 * above, so a pick made while viewing a rotated-id session lands on the same
 * row the getter will read from, instead of a stray row keyed by the UUID.
 */
export function setConversationRuntimeMode(id: string, mode: string): void {
  getDb().prepare(
    'UPDATE conversations SET runtime_mode = ?, updated_at = ? WHERE id = ?'
  ).run(mode, Date.now(), resolveRootThreadId(id))
}

/**
 * Stamp when a thread was read. Deliberately does NOT touch `updated_at` -
 * that drives sidebar ordering, and reading a chat must not reorder the list.
 *
 * Returns false when no row matched, which happens for a session that was
 * scanned off disk but never persisted. The caller still broadcasts, so the
 * badge clears everywhere either way.
 */
export function setConversationLastRead(id: string, at: number): boolean {
  // Every id of the thread: stamping one row left the badge lit under the other.
  const stmt = getDb().prepare('UPDATE conversations SET last_read_at = ? WHERE id = ?')
  let changed = 0
  for (const memberId of threadFamilyIds(id)) changed += stmt.run(at, memberId).changes
  return changed > 0
}

export function getConversationLastRead(id: string): number | null {
  const row = getDb().prepare(
    'SELECT last_read_at FROM conversations WHERE id = ?'
  ).get(resolveRootThreadId(id)) as { last_read_at: number | null } | undefined
  return row?.last_read_at ?? null
}

/**
 * Per-conversation provider instance id. Returns null if the column was
 * not yet populated (extremely old conversation, or one created before
 * the multi-instance migration ran). Callers fall back to the
 * `<agentType>-default` instance.
 *
 * Resolves through `resolveRootThreadId` first - see the comment on
 * `getConversationRuntimeMode` above. This is the fix for the sidebar
 * "provider instance keeps resetting to default" bug: the row that holds
 * the user's pick is keyed by the synthetic `agent_<ts>` id, but a chat
 * reopened from the sidebar arrives here keyed by its rotated Claude UUID.
 */
export function getConversationProviderInstanceId(id: string): string | null {
  const row = getDb().prepare(
    'SELECT provider_instance_id FROM conversations WHERE id = ?'
  ).get(resolveRootThreadId(id)) as { provider_instance_id: string | null } | undefined
  return row?.provider_instance_id ?? null
}

export function setConversationProviderInstanceId(id: string, instanceId: string): void {
  // Keep `session_id`. The claude-adapter migrates the JSONL across
  // CLAUDE_CONFIG_DIR profiles when oauth_dir differs, so resume by UUID
  // still works after a switch. Nulling here would drop history.
  //
  // Resolved through `resolveRootThreadId` so a pick made against a rotated
  // id lands on the same row the getter above reads from, instead of a
  // stray row keyed by the UUID that the getter would never see.
  getDb().prepare(
    'UPDATE conversations SET provider_instance_id = ?, updated_at = ? WHERE id = ?'
  ).run(instanceId, Date.now(), resolveRootThreadId(id))
}

/**
 * Per-conversation pinned model. Returns null if the user never pinned one
 * (callers fall back to the adapter's own default).
 *
 * Resolves through `resolveRootThreadId` first - see the comment on
 * `getConversationRuntimeMode` above. Same fallback as runtime mode and
 * provider instance, so a chat reopened from the sidebar under its rotated
 * Claude UUID still finds the pin saved under its original id.
 */
export function getConversationModel(id: string): string | null {
  const row = getDb().prepare(
    'SELECT model FROM conversations WHERE id = ?'
  ).get(resolveRootThreadId(id)) as { model: string | null } | undefined
  return row?.model ?? null
}

/**
 * Which agent this conversation's stored `model` belongs to. Switching agent
 * clears the model in the store but not in this table, so a stored model only
 * means anything next to its agent - `sessionDefaultsFor` drops it otherwise.
 * Same `resolveRootThreadId` fallback as the other per-conversation getters.
 */
export function getConversationAgentType(id: string): string | null {
  const row = getDb().prepare(
    'SELECT agent_type FROM conversations WHERE id = ?'
  ).get(resolveRootThreadId(id)) as { agent_type: string | null } | undefined
  return row?.agent_type ?? null
}

export function setConversationModel(id: string, model: string): void {
  getDb().prepare(
    'UPDATE conversations SET model = ?, updated_at = ? WHERE id = ?'
  ).run(model, Date.now(), resolveRootThreadId(id))
}

/**
 * Persist a provider switch as one SQLite statement. Provider, credential
 * profile, model pin, and native resume id must never describe different
 * providers after a reload.
 */
export function setConversationProviderSelection(
  id: string,
  agentType: string,
  instanceId: string,
): void {
  getDb().prepare(
    `UPDATE conversations SET agent_type = ?, model = NULL, provider_instance_id = ?,
     session_id = NULL, updated_at = ? WHERE id = ?`
  ).run(agentType, instanceId, Date.now(), resolveRootThreadId(id))
}

/**
 * Provider a pending cross-provider context handoff should attribute its
 * preamble to, or null when no handoff is scheduled. Set by an agent switch
 * over existing history and by degraded (non-resumable) forks; cleared when
 * the next turn is sent with the transcript preamble prefixed.
 *
 * Resolves through `resolveRootThreadId` first - see the comment on
 * `getConversationRuntimeMode` above. Without it a handoff scheduled against
 * a rotated id would never be consumed (or would re-inject after reload).
 */
export function getConversationPendingHandoff(id: string): string | null {
  const row = getDb().prepare(
    'SELECT pending_handoff_from FROM conversations WHERE id = ?'
  ).get(resolveRootThreadId(id)) as { pending_handoff_from: string | null } | undefined
  return row?.pending_handoff_from ?? null
}

export function setConversationPendingHandoff(id: string, from: string | null): void {
  getDb().prepare(
    'UPDATE conversations SET pending_handoff_from = ?, updated_at = ? WHERE id = ?'
  ).run(from, Date.now(), resolveRootThreadId(id))
}

export function archiveConversation(id: string): void {
  setConversationArchived(id, 1)
}

export function unarchiveConversation(id: string): void {
  setConversationArchived(id, 0)
}

/**
 * Applies to every id of the thread. Archiving one row left the chat listed
 * under its other id, which reads as "archive did nothing".
 */
function setConversationArchived(id: string, archived: 0 | 1): void {
  const stmt = getDb().prepare('UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ?')
  const now = Date.now()
  for (const memberId of threadFamilyIds(id)) stmt.run(archived, now, memberId)
}

export function getArchivedConversations(): Array<{ id: string; project_path: string; title: string; updated_at: number }> {
  return getDb().prepare(
    `SELECT c.id, c.project_path, c.title, c.updated_at
     FROM conversations c
     WHERE c.archived = 1 AND c.sidebar_role = 'managed'
       AND NOT EXISTS (
         SELECT 1
         FROM thread_sessions ts
         JOIN conversations root ON root.id = ts.thread_id
         WHERE ts.claude_session_id = c.id
           AND ts.thread_id != c.id
           AND root.sidebar_role = 'managed'
       )
     ORDER BY c.updated_at DESC`
  ).all() as Array<{ id: string; project_path: string; title: string; updated_at: number }>
}

export function isConversationArchived(id: string): boolean {
  const row = getDb().prepare(
    'SELECT archived FROM conversations WHERE id = ?'
  ).get(resolveRootThreadId(id)) as { archived: number } | undefined
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
    `INSERT OR IGNORE INTO conversations (id, project_path, agent_type, title, sidebar_role)
     VALUES (?, ?, ?, ?, 'managed')`
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

  // Skip silently if the conversation row doesn't exist - same guard as saveMessage
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

// saveMessage runs once per chat message on the streaming path. Statements
// are prepared once per db handle (tests open fresh DBs, so key on the
// instance), and the two writes share one transaction - previously each was
// its own implicit transaction, i.e. two WAL fsyncs per message.
interface SaveMessageArgs {
  id: string
  conversationId: string
  role: string
  content: string
  toolCalls: string | null
  images: string | null
  now: number
  displayBody: string | null
  pillsMeta: string | null
}
let saveMsg: {
  db: Database.Database
  convExists: Database.Statement
  write: Database.Transaction<(args: SaveMessageArgs) => void>
  fill: Database.Transaction<(args: SaveMessageArgs) => boolean>
} | null = null

function saveMessageStmts(db: Database.Database) {
  if (saveMsg?.db !== db) {
    const convExists = db.prepare('SELECT 1 FROM conversations WHERE id = ?')
    const cols = '(id, conversation_id, role, content, tool_calls, images, timestamp, display_body, pills_meta)'
    const values = 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    const insert = db.prepare(`INSERT OR REPLACE INTO messages ${cols} ${values}`)
    // OR IGNORE, for a writer that must not overwrite a richer row. REPLACE is
    // whole-row, so it also nulls columns the caller does not pass, and it does
    // NOT fire the FTS delete trigger (recursive_triggers is off), which leaves
    // an orphaned index row behind.
    const insertIfAbsent = db.prepare(`INSERT OR IGNORE INTO messages ${cols} ${values}`)
    const touch = db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
    const run = (stmt: Database.Statement, a: SaveMessageArgs): Database.RunResult =>
      stmt.run(a.id, a.conversationId, a.role, a.content, a.toolCalls, a.images, a.now, a.displayBody, a.pillsMeta)
    const write = db.transaction((a: SaveMessageArgs) => {
      run(insert, a)
      touch.run(a.now, a.conversationId)
    })
    const fill = db.transaction((a: SaveMessageArgs): boolean => {
      const changed = run(insertIfAbsent, a).changes > 0
      if (changed) touch.run(a.now, a.conversationId)
      return changed
    })
    saveMsg = { db, convExists, write, fill }
  }
  return saveMsg
}

export function saveMessage(
  id: string,
  conversationId: string,
  role: string,
  content: string,
  toolCalls?: string,
  images?: string,
  displayBody?: string,
  pillsMeta?: string,
): { ok: boolean; reason?: 'conversation-missing' } {
  const now = Date.now()
  const stmts = saveMessageStmts(getDb())

  // Skip silently if the conversation row doesn't exist - happens when a session
  // was imported (scanned from JSONL) but never persisted to the conversations
  // table. The renderer will call createConversation on session activation, but
  // this guard protects against race/edge cases so we don't throw.
  if (!stmts.convExists.get(conversationId)) {
    log.warn(`saveMessage: conversation ${conversationId} not found, skipping`)
    return { ok: false, reason: 'conversation-missing' }
  }

  stmts.write({
    id, conversationId, role, content,
    toolCalls: toolCalls ?? null,
    images: images ?? null,
    now,
    displayBody: displayBody ?? null,
    pillsMeta: pillsMeta ?? null,
  })
  return { ok: true }
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

export function getMessageForConversationById(
  conversationId: string,
  id: string,
): MessageRow | undefined {
  return getDb().prepare(
    'SELECT * FROM messages WHERE conversation_id = ? AND id = ?'
  ).get(conversationId, id) as MessageRow | undefined
}

function tryParseJson<T>(s: string): T | undefined {
  try { return JSON.parse(s) as T } catch { return undefined }
}

/**
 * Map persisted message rows to ChatMessage. The messages table mirrors every
 * streamed turn (saveMessage) plus JSONL-indexed history (bulkSaveMessages), so
 * this is the authoritative source when a conversation's provider JSONL is
 * missing - fork assembly and JSONL-less session loads both reuse it.
 */
export function messageRowsToChatMessages(rows: MessageRow[]): ChatMessage[] {
  return rows.map((row) => ({
    id: row.id,
    role: row.role as ChatMessage['role'],
    content: row.content,
    timestamp: row.timestamp,
    toolCalls: row.tool_calls ? tryParseJson(row.tool_calls) : undefined,
    images: row.images ? tryParseJson(row.images) : undefined,
    displayBody: row.display_body ?? undefined,
    pillsMeta: row.pills_meta ? tryParseJson(row.pills_meta) : undefined,
  }))
}

/** Pill enrichments for user messages, keyed by content. See
 *  `enrichMessagesWithDisplayBody` for the content-match rationale. */
export interface DisplayBodyEnrichment {
  displayBody?: string
  pillsMeta?: string
  images?: string
}
export function getDisplayBodyEnrichments(
  conversationId: string,
): Map<string, DisplayBodyEnrichment> {
  const rows = getDb().prepare(
    `SELECT content, display_body, pills_meta, images
       FROM messages
      WHERE conversation_id = ?
        AND role = 'user'
        AND (display_body IS NOT NULL OR images IS NOT NULL)`
  ).all(conversationId) as Array<{ content: string; display_body: string | null; pills_meta: string | null; images: string | null }>
  const out = new Map<string, DisplayBodyEnrichment>()
  for (const r of rows) {
    out.set(r.content, {
      ...(r.display_body ? { displayBody: r.display_body, pillsMeta: r.pills_meta ?? '{}' } : {}),
      ...(r.images ? { images: r.images } : {}),
    })
  }
  return out
}

/**
 * Return persisted system messages (currently used only for the in-band
 * provider-instance-rotation marker) for a conversation. JSONL fragments
 * don't carry these - they're written to SQLite by the renderer when the
 * user switches instances mid-conversation, and merged back into the
 * load-by-id output so the marker survives reload.
 */
/**
 * Write a message only if that id is absent. For a writer that is a backstop
 * rather than the owner: the backend persists a user turn so a phone-driven
 * chat is not lost, but the desktop renderer's own save carries pill metadata
 * and must win. The renderer writes BEFORE it sends, so a plain `saveMessage`
 * here landed second and nulled `display_body`/`pills_meta`.
 *
 * Returns whether a row was inserted.
 */
export function saveMessageIfAbsent(
  id: string,
  conversationId: string,
  role: string,
  content: string,
  images?: string,
  displayBody?: string,
): boolean {
  const stmts = saveMessageStmts(getDb())
  if (!stmts.convExists.get(conversationId)) {
    log.warn(`saveMessageIfAbsent: conversation ${conversationId} not found, skipping`)
    return false
  }
  return stmts.fill({
    id,
    conversationId,
    role,
    content,
    toolCalls: null,
    images: images ?? null,
    now: Date.now(),
    displayBody: displayBody ?? null,
    pillsMeta: null,
  })
}

export function getSystemMarkerMessages(conversationId: string): Array<{
  id: string
  role: string
  content: string
  timestamp: number
}> {
  // '[[sb:%' catches structural markers (rotation pill); 'Error: %' catches
  // persisted error cards. Both are Switchboard-authored system rows that the
  // JSONL reload path would otherwise drop.
  return getDb().prepare(
    `SELECT id, role, content, timestamp
       FROM messages
      WHERE conversation_id = ?
        AND role = 'system'
        AND (content LIKE '[[sb:%' OR content LIKE 'Error: %')
      ORDER BY timestamp ASC`
  ).all(conversationId) as Array<{ id: string; role: string; content: string; timestamp: number }>
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
  /** Name of the launch config this layout was hydrated from. */
  launchConfigName: string | null
}

export function saveSessionLayout(
  sessionId: string,
  layoutJson: string,
  launchConfigName?: string | null,
): void {
  getDb().prepare(
    'INSERT OR REPLACE INTO session_layouts (session_id, layout_json, launch_config_name, updated_at) VALUES (?, ?, ?, ?)'
  ).run(sessionId, layoutJson, launchConfigName ?? null, Date.now())
}

export function getSessionLayout(sessionId: string): StoredSessionLayout | null {
  const row = getDb().prepare(
    'SELECT layout_json, launch_config_name FROM session_layouts WHERE session_id = ?'
  ).get(sessionId) as { layout_json: string; launch_config_name: string | null } | undefined
  if (!row) return null
  return { layoutJson: row.layout_json, launchConfigName: row.launch_config_name }
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
        COALESCE(root.id, m.conversation_id) as conversationId,
        m.role,
        m.content,
        snippet(messages_fts, 0, '**', '**', '...', 40) as snippet
      FROM messages_fts
      JOIN messages m ON messages_fts.rowid = m.rowid
      JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN thread_sessions ts ON ts.claude_session_id = m.conversation_id
      LEFT JOIN conversations root ON root.id = ts.thread_id
      WHERE messages_fts MATCH ?
        AND COALESCE(root.sidebar_role, c.sidebar_role) = 'managed'
        AND COALESCE(root.archived, c.archived) = 0
      ORDER BY rank
      LIMIT ?
    `).all(sanitized, limit) as SearchResult[]
  } catch {
    // FTS query syntax error - fall back to LIKE
    return getDb().prepare(`
      SELECT
        m.id as messageId,
        COALESCE(root.id, m.conversation_id) as conversationId,
        m.role,
        m.content,
        substr(m.content, max(1, instr(lower(m.content), lower(?)) - 20), 80) as snippet
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN thread_sessions ts ON ts.claude_session_id = m.conversation_id
      LEFT JOIN conversations root ON root.id = ts.thread_id
      WHERE m.content LIKE ?
        AND COALESCE(root.sidebar_role, c.sidebar_role) = 'managed'
        AND COALESCE(root.archived, c.archived) = 0
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
  try { const parsed = JSON.parse(r.tags); if (Array.isArray(parsed)) tags = parsed.map(String) } catch { /* malformed - show as empty */ }
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
