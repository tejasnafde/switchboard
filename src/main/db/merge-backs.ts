import type Database from 'better-sqlite3'
import {
  formatMergeBackMarker,
  type MergeBackCursor,
  type MergeBackRow,
} from '../../shared/merge-back'

/**
 * A fork's merge-back to its parent (shared/merge-back.ts), stored so it
 * survives a restart. Keyed by ROOT conversation ids on both sides. One
 * pending merge-back per (fork, parent): a new send from the same fork
 * replaces the pending one, whose content it covers.
 *
 * The parent's system row (`message_id`) is written in the same transaction
 * as every state change, so the card a client reloads is always the state.
 */
export type MergeBackDbState = 'pending' | 'delivered' | 'discarded'

export interface StoredMergeBack {
  id: string
  parentId: string
  forkId: string
  state: MergeBackDbState
  revision: number
  row: MergeBackRow
  /** The fork's cursor once this one is delivered. */
  through: MergeBackCursor
  messageId: string
  createdAt: number
  updatedAt: number
}

interface DbRow {
  id: string
  parent_id: string
  fork_id: string
  state: MergeBackDbState
  revision: number
  row_json: string
  through_json: string
  message_id: string
  created_at: number
  updated_at: number
}

export function mergeBackMessageId(id: string): string {
  return `mergeback_${id}`
}

export function ensureMergeBackSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fork_merge_backs (
      id           TEXT PRIMARY KEY,
      parent_id    TEXT NOT NULL,
      fork_id      TEXT NOT NULL,
      state        TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'discarded')),
      revision     INTEGER NOT NULL DEFAULT 0,
      row_json     TEXT NOT NULL,
      through_json TEXT NOT NULL,
      message_id   TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fork_merge_backs_parent
      ON fork_merge_backs(parent_id, state, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fork_merge_backs_one_pending
      ON fork_merge_backs(fork_id, parent_id) WHERE state = 'pending';

    CREATE TABLE IF NOT EXISTS fork_merge_back_cursors (
      fork_id     TEXT PRIMARY KEY,
      cursor_json TEXT NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `)
}

function fromDb(row: DbRow): StoredMergeBack {
  return {
    id: row.id,
    parentId: row.parent_id,
    forkId: row.fork_id,
    state: row.state,
    revision: row.revision,
    row: JSON.parse(row.row_json) as MergeBackRow,
    through: JSON.parse(row.through_json) as MergeBackCursor,
    messageId: row.message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface DeliveredMergeBack {
  id: string
  parentId: string
  messageId: string
  content: string
  at: number
}

export class SqliteMergeBackStore {
  constructor(private readonly database: () => Database.Database) {}

  get(id: string): StoredMergeBack | null {
    const row = this.database().prepare('SELECT * FROM fork_merge_backs WHERE id = ?').get(id) as DbRow | undefined
    return row ? fromDb(row) : null
  }

  /** The end of the fork's last delivered merge-back, or null before the first. */
  cursorFor(forkId: string): MergeBackCursor | null {
    const row = this.database().prepare('SELECT cursor_json FROM fork_merge_back_cursors WHERE fork_id = ?')
      .get(forkId) as { cursor_json: string } | undefined
    return row ? JSON.parse(row.cursor_json) as MergeBackCursor : null
  }

  pendingFor(parentId: string): StoredMergeBack[] {
    return (this.database().prepare(`
      SELECT * FROM fork_merge_backs WHERE parent_id = ? AND state = 'pending' ORDER BY created_at, id
    `).all(parentId) as DbRow[]).map(fromDb)
  }

  pendingFromFork(forkId: string, parentId: string): StoredMergeBack | null {
    const row = this.database().prepare(`
      SELECT * FROM fork_merge_backs WHERE fork_id = ? AND parent_id = ? AND state = 'pending'
    `).get(forkId, parentId) as DbRow | undefined
    return row ? fromDb(row) : null
  }

  /**
   * Store a new pending merge-back and its card in the parent. A pending one
   * from the same fork is replaced (its card removed): the new summary starts
   * at the same cursor, so it covers everything the old one did.
   */
  createPending(input: {
    id: string
    parentId: string
    forkId: string
    row: MergeBackRow
    through: MergeBackCursor
    now: number
  }): { created: StoredMergeBack; replaced: StoredMergeBack | null } {
    const db = this.database()
    return db.transaction(() => {
      const replaced = this.pendingFromFork(input.forkId, input.parentId)
      if (replaced) {
        db.prepare("UPDATE fork_merge_backs SET state = 'discarded', updated_at = ? WHERE id = ?").run(input.now, replaced.id)
        db.prepare('DELETE FROM messages WHERE id = ? AND conversation_id = ?').run(replaced.messageId, replaced.parentId)
      }
      const messageId = mergeBackMessageId(input.id)
      db.prepare(`
        INSERT INTO fork_merge_backs
          (id, parent_id, fork_id, state, revision, row_json, through_json, message_id, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)
      `).run(input.id, input.parentId, input.forkId, JSON.stringify(input.row), JSON.stringify(input.through), messageId, input.now, input.now)
      db.prepare(`
        INSERT INTO messages (id, conversation_id, role, content, tool_calls, images, timestamp)
        VALUES (?, ?, 'system', ?, NULL, NULL, ?)
      `).run(messageId, input.parentId, formatMergeBackMarker(input.row), input.now)
      const created = this.get(input.id)
      if (!created) throw new Error('merge-back row was not persisted')
      return { created, replaced }
    })()
  }

  /** Replace a pending merge-back's text. Null when it is no longer pending. */
  editText(id: string, text: string, now: number): StoredMergeBack | null {
    const db = this.database()
    return db.transaction(() => {
      const current = this.get(id)
      if (!current || current.state !== 'pending') return null
      const row: MergeBackRow = { ...current.row, text }
      db.prepare(`
        UPDATE fork_merge_backs SET row_json = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND state = 'pending'
      `).run(JSON.stringify(row), now, id)
      db.prepare('UPDATE messages SET content = ? WHERE id = ? AND conversation_id = ?')
        .run(formatMergeBackMarker(row), current.messageId, current.parentId)
      return this.get(id)
    })()
  }

  /** Drop a pending merge-back and its card. Null when it is no longer pending. */
  discard(id: string, now: number): StoredMergeBack | null {
    const db = this.database()
    return db.transaction(() => {
      const current = this.get(id)
      if (!current || current.state !== 'pending') return null
      db.prepare("UPDATE fork_merge_backs SET state = 'discarded', updated_at = ? WHERE id = ? AND state = 'pending'").run(now, id)
      db.prepare('DELETE FROM messages WHERE id = ? AND conversation_id = ?').run(current.messageId, current.parentId)
      return current
    })()
  }

  /**
   * Mark merge-backs delivered, inside the caller's transaction (the user
   * turn's commit). Each one is delivered only from `pending` at the revision
   * that was sent, so it is delivered exactly once; its card becomes the
   * delivered row just above the user's message, and the fork's cursor moves
   * to its end.
   */
  markDeliveredInTransaction(
    db: Database.Database,
    sent: ReadonlyArray<{ id: string; revision: number }>,
    acceptedAt: number,
  ): DeliveredMergeBack[] {
    const delivered: DeliveredMergeBack[] = []
    for (const { id, revision } of sent) {
      const changed = db.prepare(`
        UPDATE fork_merge_backs SET state = 'delivered', updated_at = ?
         WHERE id = ? AND state = 'pending' AND revision = ?
      `).run(acceptedAt, id, revision).changes
      if (changed !== 1) continue
      const row = db.prepare('SELECT * FROM fork_merge_backs WHERE id = ?').get(id) as DbRow
      const stored = fromDb(row)
      const content = formatMergeBackMarker({ ...stored.row, state: 'delivered' })
      const at = acceptedAt - 1
      db.prepare('UPDATE fork_merge_backs SET row_json = ? WHERE id = ?')
        .run(JSON.stringify({ ...stored.row, state: 'delivered' }), id)
      db.prepare('UPDATE messages SET content = ?, timestamp = ? WHERE id = ? AND conversation_id = ?')
        .run(content, at, stored.messageId, stored.parentId)
      const previous = db.prepare('SELECT cursor_json FROM fork_merge_back_cursors WHERE fork_id = ?')
        .get(stored.forkId) as { cursor_json: string } | undefined
      const previousAt = previous ? (JSON.parse(previous.cursor_json) as MergeBackCursor).at : -Infinity
      // Never backwards, whatever order deliveries commit in.
      if (stored.through.at >= previousAt) {
        db.prepare(`
          INSERT INTO fork_merge_back_cursors (fork_id, cursor_json, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(fork_id) DO UPDATE SET cursor_json = excluded.cursor_json, updated_at = excluded.updated_at
        `).run(stored.forkId, JSON.stringify(stored.through), acceptedAt)
      }
      delivered.push({ id, parentId: stored.parentId, messageId: stored.messageId, content, at })
    }
    return delivered
  }
}
