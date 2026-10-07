/**
 * Messages an adapter holds until the running turn ends. Their chat row is
 * committed when they are queued, so a message that never runs (the session
 * stopped, the CLI died, the backend restarted) would read as sent forever.
 * Each one is recorded here until it leaves the queue; one that leaves
 * without running, or is still here after a restart, has its row replaced by
 * an error row that keeps the text.
 */
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { queuedTurnNotSentMessage, type QueuedTurnNotSentCause } from '@shared/queued-turns'

/** Rows written by an earlier process are the ones a restart left behind. */
const LAUNCH = randomUUID()

export function ensureQueuedTurnRowsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS queued_turn_rows (
      message_id      TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      text            TEXT NOT NULL,
      queued_at       INTEGER NOT NULL,
      launch          TEXT NOT NULL
    );
  `)
}

export interface NotSentRow {
  conversationId: string
  messageId: string
  /** The error row that replaced the message. */
  content: string
}

export interface QueuedTurnRowStore {
  record(row: { messageId: string; conversationId: string; text: string; queuedAt: number }): void
  /** It ran, was promoted or was cancelled: nothing to fix. */
  forget(messageId: string): void
  /** It left the queue without running. Null when it was never recorded. */
  markNotSent(messageId: string, cause: QueuedTurnNotSentCause): NotSentRow | null
  /** Every message an earlier process held and never ran. */
  sweepEarlierLaunches(): NotSentRow[]
}

export function sqliteQueuedTurnRowStore(db: () => Database.Database): QueuedTurnRowStore {
  const convert = (d: Database.Database, row: { message_id: string; conversation_id: string; text: string; queued_at: number }, cause: QueuedTurnNotSentCause): NotSentRow => {
    const content = `Error: ${queuedTurnNotSentMessage(row.text, cause)}`
    // The images go onto the not-sent row, so the whole message can be sent again.
    const images = (d.prepare("SELECT images FROM messages WHERE id = ? AND conversation_id = ? AND role = 'user'")
      .get(row.message_id, row.conversation_id) as { images: string | null } | undefined)?.images ?? null
    d.prepare("DELETE FROM messages WHERE id = ? AND conversation_id = ? AND role = 'user'").run(row.message_id, row.conversation_id)
    d.prepare(
      `INSERT OR IGNORE INTO messages (id, conversation_id, role, content, images, timestamp)
       SELECT ?, ?, 'system', ?, ?, ? WHERE EXISTS (SELECT 1 FROM conversations WHERE id = ?)`,
    ).run(`queued_not_sent_${row.message_id}`, row.conversation_id, content, images, row.queued_at, row.conversation_id)
    d.prepare('DELETE FROM queued_turn_rows WHERE message_id = ?').run(row.message_id)
    return { conversationId: row.conversation_id, messageId: row.message_id, content }
  }
  type Row = { message_id: string; conversation_id: string; text: string; queued_at: number }
  return {
    record(row) {
      db().prepare('INSERT OR REPLACE INTO queued_turn_rows (message_id, conversation_id, text, queued_at, launch) VALUES (?, ?, ?, ?, ?)')
        .run(row.messageId, row.conversationId, row.text, row.queuedAt, LAUNCH)
    },
    forget(messageId) {
      db().prepare('DELETE FROM queued_turn_rows WHERE message_id = ?').run(messageId)
    },
    markNotSent(messageId, cause) {
      const d = db()
      return d.transaction(() => {
        const row = d.prepare('SELECT * FROM queued_turn_rows WHERE message_id = ?').get(messageId) as Row | undefined
        return row ? convert(d, row, cause) : null
      })()
    },
    sweepEarlierLaunches() {
      const d = db()
      return d.transaction(() => {
        const rows = d.prepare('SELECT * FROM queued_turn_rows WHERE launch != ? ORDER BY queued_at').all(LAUNCH) as Row[]
        return rows.map((row) => convert(d, row, 'restarted'))
      })()
    },
  }
}
