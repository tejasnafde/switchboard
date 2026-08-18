import type Database from 'better-sqlite3'

export type TurnAcceptanceState = 'reserved' | 'dispatching' | 'completed'

export interface TurnAcceptanceKey {
  clientScope: string
  threadId: string
  origin: string
}

export type ReserveTurnResult =
  | { kind: 'reserved'; state: 'reserved' }
  | { kind: 'duplicate'; state: TurnAcceptanceState }
  | { kind: 'conflict'; state: TurnAcceptanceState }

export interface TurnAcceptanceStore {
  reserve(key: TurnAcceptanceKey, payloadHash: string): ReserveTurnResult
  beginDispatch(key: TurnAcceptanceKey, payloadHash: string): boolean
  complete(key: TurnAcceptanceKey, payloadHash: string): boolean
  release(key: TurnAcceptanceKey, payloadHash: string): boolean
}

interface AcceptanceRow {
  payload_hash: string
  state: TurnAcceptanceState
}

export function ensureTurnAcceptanceSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mobile_turn_acceptances (
      client_scope TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'dispatching', 'completed')),
      accepted_at INTEGER NOT NULL,
      completed_at INTEGER,
      PRIMARY KEY (client_scope, thread_id, origin)
    ) WITHOUT ROWID;
  `)
}

/**
 * Reservations are created before the provider boundary. If this process dies
 * before the reserved -> dispatching CAS, retrying is safe because the provider
 * was never called. Dispatching rows are deliberately retained as ambiguous.
 */
export function recoverUndispatchedTurns(db: Database.Database): void {
  db.prepare("DELETE FROM mobile_turn_acceptances WHERE state = 'reserved'").run()
}

export class SqliteTurnAcceptanceStore implements TurnAcceptanceStore {
  constructor(private readonly database: () => Database.Database) {}

  reserve(key: TurnAcceptanceKey, payloadHash: string): ReserveTurnResult {
    const db = this.database()
    const result = db.prepare(`
      INSERT OR IGNORE INTO mobile_turn_acceptances
        (client_scope, thread_id, origin, payload_hash, state, accepted_at)
      VALUES (?, ?, ?, ?, 'reserved', ?)
    `).run(key.clientScope, key.threadId, key.origin, payloadHash, Date.now())
    if (result.changes === 1) return { kind: 'reserved', state: 'reserved' }

    const row = this.read(db, key)
    if (!row) throw new Error('turn acceptance reservation disappeared')
    if (row.payload_hash !== payloadHash) return { kind: 'conflict', state: row.state }
    return { kind: 'duplicate', state: row.state }
  }

  beginDispatch(key: TurnAcceptanceKey, payloadHash: string): boolean {
    return this.database().prepare(`
      UPDATE mobile_turn_acceptances
         SET state = 'dispatching'
       WHERE client_scope = ? AND thread_id = ? AND origin = ?
         AND payload_hash = ? AND state = 'reserved'
    `).run(key.clientScope, key.threadId, key.origin, payloadHash).changes === 1
  }

  complete(key: TurnAcceptanceKey, payloadHash: string): boolean {
    return this.database().prepare(`
      UPDATE mobile_turn_acceptances
         SET state = 'completed', completed_at = ?
       WHERE client_scope = ? AND thread_id = ? AND origin = ?
         AND payload_hash = ? AND state = 'dispatching'
    `).run(Date.now(), key.clientScope, key.threadId, key.origin, payloadHash).changes === 1
  }

  release(key: TurnAcceptanceKey, payloadHash: string): boolean {
    return this.database().prepare(`
      DELETE FROM mobile_turn_acceptances
       WHERE client_scope = ? AND thread_id = ? AND origin = ?
         AND payload_hash = ? AND state IN ('reserved', 'dispatching')
    `).run(key.clientScope, key.threadId, key.origin, payloadHash).changes === 1
  }

  private read(db: Database.Database, key: TurnAcceptanceKey): AcceptanceRow | undefined {
    return db.prepare(`
      SELECT payload_hash, state
        FROM mobile_turn_acceptances
       WHERE client_scope = ? AND thread_id = ? AND origin = ?
    `).get(key.clientScope, key.threadId, key.origin) as AcceptanceRow | undefined
  }
}
