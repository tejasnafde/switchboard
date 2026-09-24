import { createMainLogger as createLogger } from '../logger'
import { parseErrorKind } from './parse-error'
import Database from 'better-sqlite3'
import type { ChatMessage, FileDiffAttachment, ToolCall } from '@shared/types'
import { getDb } from './database'
import { threadFamilyIds } from './conversations'

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
      // Wall clock, not `a.now`: a backdated row must not age the conversation.
      if (changed) touch.run(Date.now(), a.conversationId)
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

/**
 * Remove a user message that never reached the agent: a queued message the
 * user took back. Only a user row, only in its own conversation.
 */
export function deleteUserMessage(conversationId: string, messageId: string): boolean {
  return getDb().prepare(
    "DELETE FROM messages WHERE id = ? AND conversation_id = ? AND role = 'user'"
  ).run(messageId, conversationId).changes > 0
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
  /** Card attachments (`{ fileDiff }`); column added by ensureConversationForkSchema. */
  attachments_json?: string | null
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
    log.warn('stored message JSON did not parse (contents not logged)', parseErrorKind(err))
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
    ...fileDiffFromAttachments(row.attachments_json),
  }))
}

/** Only the changed-file card: the other fork attachments are live-only cards. */
function fileDiffFromAttachments(json: string | null | undefined): Pick<ChatMessage, 'fileDiff'> {
  const fileDiff = json ? tryParseJson<{ fileDiff?: FileDiffAttachment }>(json)?.fileDiff : undefined
  return fileDiff ? { fileDiff } : {}
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
  timestamp?: number,
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
    now: timestamp ?? Date.now(),
    displayBody: displayBody ?? null,
    pillsMeta: null,
  })
}

let activityStmts: { db: Database.Database; insert: Database.Statement; setStatus: Database.Statement } | null = null

function activityMessageStmts(db: Database.Database) {
  if (activityStmts?.db !== db) {
    activityStmts = {
      db,
      insert: db.prepare(
        `INSERT OR IGNORE INTO messages (id, conversation_id, role, content, tool_calls, timestamp, attachments_json)
         VALUES (?, ?, 'assistant', '', ?, ?, ?)`,
      ),
      setStatus: db.prepare(
        `UPDATE messages SET attachments_json = json_set(attachments_json, '$.fileDiff.status', ?)
          WHERE id = ? AND conversation_id = ? AND json_extract(attachments_json, '$.fileDiff') IS NOT NULL`,
      ),
    }
  }
  return activityStmts
}

/**
 * Mirror one of a turn's tool or changed-file rows, if that id is absent.
 * The renderer builds these rows live and never saves them, so without this a
 * reload shows neither (only Claude's transcript keeps its tool calls). The
 * card goes in `attachments_json`, where a fork already copies it.
 */
export function saveActivityMessageIfAbsent(row: {
  id: string
  conversationId: string
  timestamp: number
  toolCalls?: ToolCall[]
  fileDiff?: FileDiffAttachment
}): boolean {
  const db = getDb()
  if (!saveMessageStmts(db).convExists.get(row.conversationId)) {
    log.warn(`saveActivityMessageIfAbsent: conversation ${row.conversationId} not found, skipping`)
    return false
  }
  return activityMessageStmts(db).insert.run(
    row.id,
    row.conversationId,
    row.toolCalls ? JSON.stringify(row.toolCalls) : null,
    row.timestamp,
    row.fileDiff ? JSON.stringify({ fileDiff: row.fileDiff }) : null,
  ).changes > 0
}

/**
 * Record the user's accept/reject on a stored changed-file card. Looked up
 * across the thread family: the sidebar may hand back a rotated session id.
 */
export function setFileDiffStatus(
  conversationId: string,
  messageId: string,
  status: FileDiffAttachment['status'],
): boolean {
  const { setStatus } = activityMessageStmts(getDb())
  return threadFamilyIds(conversationId).some((id) => setStatus.run(status, messageId, id).changes > 0)
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
