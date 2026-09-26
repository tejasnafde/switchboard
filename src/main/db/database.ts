import Database from 'better-sqlite3'
import { userDataDir } from '../runtime'
import { join } from 'path'
import { existsSync, mkdirSync, renameSync } from 'fs'
import { createMainLogger as createLogger } from '../logger'
import { AGENT_TYPES, defaultInstanceId } from '@shared/types'
import { deriveProjectPositions } from './project-ordering'
import { ensureTurnAcceptanceSchema, recoverUndispatchedTurns } from './turn-acceptance'
import { searchMessagesInDatabase, type SearchResult } from './message-search'
import { ensureConversationForkSchema } from './conversation-fork'
import { ensureWorktreeCreationSchema } from './worktree-creation'
import { ensureBookmarksTable } from './bookmarks'

const log = createLogger('db')

export * from './projects'
export * from './conversations'
export * from './messages'
export * from './settings'
export * from './kanban'
export * from './bookmarks'
export * from './worktree-links'

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
  } catch (err) {
    log.warn('messages table migration failed (images/display_body/pills_meta columns)', err)
  }

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
    // Migration (2026-09-17 - execution-root relocation): optimistic
    // concurrency token for the conversation's execution root. Bumped in the
    // same statement that moves `worktree_path`, so a client holding an old
    // revision cannot drag the root back after a newer move committed.
    // Nullable with no backfill: a row written before this column existed has
    // never been relocated, and null reads as 0.
    if (!cols.some((c) => c.name === 'execution_root_revision')) {
      db.exec('ALTER TABLE conversations ADD COLUMN execution_root_revision INTEGER')
    }
  } catch (err) {
    log.warn('conversations table migration failed', err)
  }

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
  } catch (err) {
    log.warn('session_layouts table migration failed (launch_config_name column)', err)
  }

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
  } catch (err) {
    log.warn('thread_sessions chain flattening failed - best-effort, can be re-run on next launch', err)
  }

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
  } catch (err) {
    log.warn('kanban_cards table migration failed (runtime_mode column)', err)
  }

  ensureBookmarksTable(db)

  // Provider instances: named credential sets scoped to an agent kind.
  // See src/main/db/provider-instances.ts for the encryption contract.
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

  // Migration (2026-08-24): preserve where an app-owned conversation was
  // imported from without pretending that source is a runnable provider.
  // Cursor imports continue through Claude Code, while the sidebar and remote
  // clients retain the original Cursor provenance.
  if (!convCols.some((c) => c.name === 'origin_source')) {
    db.exec('ALTER TABLE conversations ADD COLUMN origin_source TEXT')
  }

  // Migration (2026-09-24): the Follow chip per conversation. `follow_suggestions`
  // is the user's choice (NULL = auto); `worked_worktrees` a JSON array of the
  // distinct worktrees drift checks saw the agent in, which turns the chip off
  // on its own for a chat that has worked in more than two.
  if (!convCols.some((c) => c.name === 'follow_suggestions')) {
    db.exec('ALTER TABLE conversations ADD COLUMN follow_suggestions TEXT')
  }
  if (!convCols.some((c) => c.name === 'worked_worktrees')) {
    db.exec('ALTER TABLE conversations ADD COLUMN worked_worktrees TEXT')
  }
  // Migration (2026-09-25): 1 once the user closes the "Follow suggestions are
  // off" notice, so it does not come back with the next drift. NULL = not closed.
  if (!convCols.some((c) => c.name === 'follow_notice_dismissed')) {
    db.exec('ALTER TABLE conversations ADD COLUMN follow_notice_dismissed INTEGER')
  }

  // Migration (2026-09-25): the last turn's status line (agent digest, else a
  // plain preview), so every list shows a chat's summary without loading its
  // messages. Filled on turn end, or lazily the first time history loads.
  if (!convCols.some((c) => c.name === 'status_line')) {
    db.exec('ALTER TABLE conversations ADD COLUMN status_line TEXT')
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
  } catch (err) {
    log.warn('FTS index rebuild failed - search may miss recent messages until next launch', err)
  }

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
  ensureConversationForkSchema(db)
  recoverUndispatchedTurns(db)
  ensureWorktreeCreationSchema(db)

  log.info('database migrated')
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

// ─── Search ────────────────────────────────────────────────────

export function searchMessages(query: string, limit = 50): SearchResult[] {
  return searchMessagesInDatabase(getDb(), query, limit)
}
