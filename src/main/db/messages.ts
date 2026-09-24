import { createMainLogger as createLogger } from '../logger'
import Database from 'better-sqlite3'
import type { ChatMessage } from '@shared/types'
import { getDb } from './database'

const log = createLogger('db')

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
  try {
    return JSON.parse(s) as T
  } catch (err) {
    log.debug('stored message JSON did not parse', err)
    return undefined
  }
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
