import Database from 'better-sqlite3'
import type { HeldPeerMessage, HeldPeerMessageStore } from '@shared/peer-held-messages'
import { getDb } from './database'

// ─── Held peer messages ─────────────────────────────────────────
//
// Agent messages a session link refused only because its time was up
// (`shared/peer-held-messages.ts`), kept until they are delivered, so a
// backend restart does not drop them.

export function ensurePeerHeldMessageSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS peer_held_messages (
      id             TEXT PRIMARY KEY,
      from_thread_id TEXT NOT NULL,
      from_root      TEXT NOT NULL,
      from_label     TEXT NOT NULL,
      target_root    TEXT NOT NULL,
      target_label   TEXT NOT NULL,
      text           TEXT NOT NULL,
      held_at        INTEGER NOT NULL
    );
  `)
}

interface Row {
  id: string
  from_thread_id: string
  from_root: string
  from_label: string
  target_root: string
  target_label: string
  text: string
  held_at: number
}

export function sqliteHeldPeerMessageStore(db: () => Database.Database = () => getDb()): HeldPeerMessageStore {
  return {
    all() {
      const rows = db().prepare('SELECT * FROM peer_held_messages ORDER BY held_at').all() as Row[]
      return rows.map((r) => ({
        id: r.id,
        fromThreadId: r.from_thread_id,
        fromRoot: r.from_root,
        fromLabel: r.from_label,
        targetRoot: r.target_root,
        targetLabel: r.target_label,
        text: r.text,
        heldAt: r.held_at,
      }))
    },
    put(m: HeldPeerMessage) {
      db()
        .prepare(
          `INSERT OR REPLACE INTO peer_held_messages
             (id, from_thread_id, from_root, from_label, target_root, target_label, text, held_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(m.id, m.fromThreadId, m.fromRoot, m.fromLabel, m.targetRoot, m.targetLabel, m.text, m.heldAt)
    },
    remove(id) {
      db().prepare('DELETE FROM peer_held_messages WHERE id = ?').run(id)
    },
  }
}
