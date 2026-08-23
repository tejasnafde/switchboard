import type Database from 'better-sqlite3'

export interface CursorSnapshotMessage {
  id: string
  role: string
  content: string
  timestamp: number
}

export interface CursorSnapshot {
  composerId: string
  projectPath: string
  title: string
  startedAt: number
  sourceMessageCount: number
  messages: CursorSnapshotMessage[]
}

export interface CursorSnapshotResult {
  conversationId: string
  refreshed: boolean
}

export function importCursorSnapshot(
  db: Database.Database,
  snapshot: CursorSnapshot,
): CursorSnapshotResult {
  if (snapshot.sourceMessageCount > 0 && snapshot.messages.length === 0) {
    throw new Error('Cursor reported messages, but their content could not be loaded')
  }
  const conversationId = `cursor:${snapshot.composerId}`
  return db.transaction((): CursorSnapshotResult => {
    const existing = db.prepare(
      'SELECT project_path, origin_source, pending_handoff_from FROM conversations WHERE id = ?',
    ).get(conversationId) as {
      project_path: string
      origin_source: string | null
      pending_handoff_from: string | null
    } | undefined
    if (existing && existing.project_path !== snapshot.projectPath) {
      throw new Error('This Cursor conversation belongs to another project in Switchboard')
    }
    if (existing && existing.origin_source !== 'cursor') {
      throw new Error('This conversation ID is already used by a non-Cursor conversation')
    }

    const continued = existing && (
      existing.pending_handoff_from !== 'cursor'
      || Boolean(db.prepare(
        'SELECT 1 FROM conversation_segments WHERE conversation_id = ? LIMIT 1',
      ).get(conversationId))
    )
    if (continued) {
      db.prepare(`
        UPDATE conversations
        SET archived = 0, sidebar_role = 'managed'
        WHERE id = ?
      `).run(conversationId)
      return { conversationId, refreshed: false }
    }

    const updatedAt = snapshot.messages.reduce(
      (latest, message) => Math.max(latest, message.timestamp),
      snapshot.startedAt,
    )

    if (!existing) {
      db.prepare(`
        INSERT INTO conversations (
          id, project_path, agent_type, session_id, title,
          created_at, updated_at, archived, sidebar_role,
          pending_handoff_from, origin_source
        ) VALUES (?, ?, 'claude-code', NULL, ?, ?, ?, 0, 'managed', 'cursor', 'cursor')
      `).run(conversationId, snapshot.projectPath, snapshot.title, snapshot.startedAt, updatedAt)
    } else {
      db.prepare(`
        UPDATE conversations
        SET archived = 0, sidebar_role = 'managed', title = ?,
            origin_source = 'cursor', updated_at = ?
        WHERE id = ?
      `).run(snapshot.title, updatedAt, conversationId)
    }

    if (existing) {
      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId)
      db.prepare(`
        UPDATE conversations
        SET agent_type = 'claude-code', session_id = NULL,
            pending_handoff_from = 'cursor'
        WHERE id = ?
      `).run(conversationId)
    }

    const insertMessage = db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `)
    for (const message of snapshot.messages) {
      if (!message.content) continue
      insertMessage.run(
        message.id,
        conversationId,
        message.role,
        message.content,
        message.timestamp,
      )
    }
    return { conversationId, refreshed: true }
  })()
}
