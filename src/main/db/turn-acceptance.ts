import type Database from 'better-sqlite3'

export type TurnAcceptanceState = 'reserved' | 'dispatching' | 'completed' | 'abandoned'

export interface TurnAcceptanceKey {
  clientScope: string
  threadId: string
  origin: string
}

export type ReserveTurnResult =
  | { kind: 'reserved'; state: 'reserved' }
  | { kind: 'duplicate'; state: TurnAcceptanceState }
  | { kind: 'conflict'; state: TurnAcceptanceState }

export type ReserveEnvelopeResult = ReserveTurnResult | {
  kind: 'blocked'
  state: 'reserved' | 'dispatching'
  blockingOrigin: string
} | {
  kind: 'duplicate'
  state: TurnAcceptanceState
  clientScope: string
}

export interface AcceptedUserTurnRecord {
  messageId: string
  providerText: string
  imagesJson?: string
  displayBody?: string
  pillsMetaJson?: string
  acceptedAt: number
  autoTitle?: string
  handoff?: {
    expectedFrom: string
    markerId: string
    markerText: string
  }
}

export interface CanonicalUserTurnRow {
  messageId: string
  providerText: string
  imagesJson: string | null
  displayBody: string | null
  pillsMetaJson: string | null
  eventAt: number
  conversationTitle: string | null
  envelopeJson: string | null
}

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
  const columns = db.prepare('PRAGMA table_info(mobile_turn_acceptances)').all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'envelope_json')) {
    db.exec('ALTER TABLE mobile_turn_acceptances ADD COLUMN envelope_json TEXT')
  }
  if (!columns.some((column) => column.name === 'message_id')) {
    db.exec('ALTER TABLE mobile_turn_acceptances ADD COLUMN message_id TEXT')
  }
  if (!columns.some((column) => column.name === 'event_at')) {
    db.exec('ALTER TABLE mobile_turn_acceptances ADD COLUMN event_at INTEGER')
  }
  const table = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mobile_turn_acceptances'
  `).get() as { sql: string } | undefined
  if (table && !table.sql.includes("'abandoned'")) {
    db.transaction(() => {
      db.exec(`
        DROP INDEX IF EXISTS idx_turn_acceptances_thread_state;
        ALTER TABLE mobile_turn_acceptances RENAME TO mobile_turn_acceptances_before_resolution;
        CREATE TABLE mobile_turn_acceptances (
          client_scope TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          origin TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('reserved', 'dispatching', 'completed', 'abandoned')),
          accepted_at INTEGER NOT NULL,
          completed_at INTEGER,
          envelope_json TEXT,
          message_id TEXT,
          event_at INTEGER,
          PRIMARY KEY (client_scope, thread_id, origin)
        ) WITHOUT ROWID;
        INSERT INTO mobile_turn_acceptances
          (client_scope, thread_id, origin, payload_hash, state, accepted_at,
           completed_at, envelope_json, message_id, event_at)
        SELECT client_scope, thread_id, origin, payload_hash, state, accepted_at,
               completed_at, envelope_json, message_id, event_at
          FROM mobile_turn_acceptances_before_resolution;
        DROP TABLE mobile_turn_acceptances_before_resolution;
      `)
    })()
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_turn_acceptances_thread_state
      ON mobile_turn_acceptances(thread_id, state)
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

  reserveEnvelope(
    key: TurnAcceptanceKey,
    payloadHash: string,
    envelopeJson: string,
    messageId: string,
    eventAt: number,
  ): ReserveEnvelopeResult {
    const db = this.database()
    return db.transaction((): ReserveEnvelopeResult => {
      const existing = this.read(db, key)
      if (existing) {
        if (existing.payload_hash !== payloadHash) return { kind: 'conflict', state: existing.state }
        return { kind: 'duplicate', state: existing.state }
      }
      const sameOrigin = db.prepare(`
        SELECT client_scope AS clientScope, payload_hash AS payloadHash, state
          FROM mobile_turn_acceptances
         WHERE thread_id = ? AND origin = ?
         LIMIT 1
      `).get(key.threadId, key.origin) as {
        clientScope: string
        payloadHash: string
        state: TurnAcceptanceState
      } | undefined
      if (sameOrigin) {
        if (sameOrigin.payloadHash !== payloadHash) return { kind: 'conflict', state: sameOrigin.state }
        return { kind: 'duplicate', state: sameOrigin.state, clientScope: sameOrigin.clientScope }
      }
      const blocker = db.prepare(`
        SELECT origin, state
          FROM mobile_turn_acceptances
         WHERE thread_id = ? AND state IN ('reserved', 'dispatching')
         ORDER BY accepted_at ASC
         LIMIT 1
      `).get(key.threadId) as { origin: string; state: 'reserved' | 'dispatching' } | undefined
      if (blocker) {
        return { kind: 'blocked', state: blocker.state, blockingOrigin: blocker.origin }
      }
      db.prepare(`
        INSERT INTO mobile_turn_acceptances
          (client_scope, thread_id, origin, payload_hash, state, accepted_at,
           envelope_json, message_id, event_at)
        VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?, ?)
      `).run(
        key.clientScope,
        key.threadId,
        key.origin,
        payloadHash,
        eventAt,
        envelopeJson,
        messageId,
        eventAt,
      )
      return { kind: 'reserved', state: 'reserved' }
    })()
  }

  readEnvelope(key: TurnAcceptanceKey): string | null {
    const row = this.database().prepare(`
      SELECT envelope_json
        FROM mobile_turn_acceptances
       WHERE client_scope = ? AND thread_id = ? AND origin = ?
    `).get(key.clientScope, key.threadId, key.origin) as { envelope_json: string | null } | undefined
    return row?.envelope_json ?? null
  }

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

  resolveAmbiguous(
    key: TurnAcceptanceKey,
    resolution: 'abandon',
  ): { state: TurnAcceptanceState | 'not_found'; changed: boolean } {
    if (resolution !== 'abandon') throw new Error('unsupported turn resolution')
    const db = this.database()
    return db.transaction(() => {
      const row = db.prepare(`
        SELECT state FROM mobile_turn_acceptances
         WHERE client_scope = ? AND thread_id = ? AND origin = ?
         LIMIT 1
      `).get(key.clientScope, key.threadId, key.origin) as { state: TurnAcceptanceState } | undefined
      if (!row) return { state: 'not_found' as const, changed: false }
      if (row.state !== 'dispatching') return { state: row.state, changed: false }
      const changed = db.prepare(`
        UPDATE mobile_turn_acceptances
           SET state = 'abandoned', completed_at = ?
         WHERE client_scope = ? AND thread_id = ? AND origin = ? AND state = 'dispatching'
      `).run(Date.now(), key.clientScope, key.threadId, key.origin).changes === 1
      return { state: changed ? 'abandoned' as const : row.state, changed }
    })()
  }

  completeUserTurn(
    key: TurnAcceptanceKey,
    payloadHash: string,
    turn: AcceptedUserTurnRecord,
  ): { completed: boolean; conversationTitle?: string } {
    const db = this.database()
    return db.transaction(() => {
      const completion = db.prepare(`
        UPDATE mobile_turn_acceptances
           SET state = 'completed', completed_at = ?, event_at = ?
         WHERE client_scope = ? AND thread_id = ? AND origin = ?
           AND payload_hash = ? AND state = 'dispatching'
      `).run(
        turn.acceptedAt,
        turn.acceptedAt,
        key.clientScope,
        key.threadId,
        key.origin,
        payloadHash,
      )
      if (completion.changes !== 1) return { completed: false }

      const hasAcceptedUserTurn = Boolean(db.prepare(`
        SELECT 1 FROM messages
         WHERE conversation_id = ? AND role = 'user'
         LIMIT 1
      `).get(key.threadId))
      const transcript = db.prepare(`
        INSERT INTO messages
          (id, conversation_id, role, content, tool_calls, images, timestamp, display_body, pills_meta)
        VALUES (?, ?, 'user', ?, NULL, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          content = excluded.content,
          images = COALESCE(excluded.images, messages.images),
          display_body = COALESCE(excluded.display_body, messages.display_body),
          pills_meta = COALESCE(excluded.pills_meta, messages.pills_meta)
        WHERE messages.conversation_id = excluded.conversation_id
          AND messages.role = 'user'
      `).run(
        turn.messageId,
        key.threadId,
        turn.providerText,
        turn.imagesJson ?? null,
        turn.acceptedAt,
        turn.displayBody ?? null,
        turn.pillsMetaJson ?? null,
      )
      if (transcript.changes !== 1) {
        throw new Error('canonical user message id belongs to another turn')
      }

      if (turn.handoff) {
        db.prepare(`
          INSERT OR IGNORE INTO messages
            (id, conversation_id, role, content, tool_calls, images, timestamp, display_body, pills_meta)
          VALUES (?, ?, 'system', ?, NULL, NULL, ?, NULL, NULL)
        `).run(turn.handoff.markerId, key.threadId, turn.handoff.markerText, turn.acceptedAt - 1)
        db.prepare(`
          UPDATE conversations
             SET pending_handoff_from = NULL
           WHERE id = ? AND pending_handoff_from = ?
        `).run(key.threadId, turn.handoff.expectedFrom)
      }

      let conversationTitle: string | undefined
      if (!hasAcceptedUserTurn && turn.autoTitle) {
        const changed = db.prepare(`
          UPDATE conversations
             SET title = ?
           WHERE id = ? AND title = 'New conversation'
        `).run(turn.autoTitle, key.threadId).changes
        if (changed === 1) conversationTitle = turn.autoTitle
      }
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
        .run(turn.acceptedAt, key.threadId)
      return { completed: true, ...(conversationTitle ? { conversationTitle } : {}) }
    })()
  }

  readCanonicalUserTurn(key: TurnAcceptanceKey): CanonicalUserTurnRow | null {
    const row = this.database().prepare(`
      SELECT a.message_id AS messageId,
             m.content AS providerText,
             m.images AS imagesJson,
             m.display_body AS displayBody,
             m.pills_meta AS pillsMetaJson,
             COALESCE(a.event_at, m.timestamp) AS eventAt,
             c.title AS conversationTitle,
             a.envelope_json AS envelopeJson
        FROM mobile_turn_acceptances a
        JOIN messages m ON m.id = a.message_id AND m.conversation_id = a.thread_id
        JOIN conversations c ON c.id = a.thread_id
       WHERE a.client_scope = ? AND a.thread_id = ? AND a.origin = ?
         AND a.state = 'completed'
    `).get(key.clientScope, key.threadId, key.origin) as CanonicalUserTurnRow | undefined
    return row ?? null
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
