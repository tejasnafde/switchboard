import type Database from 'better-sqlite3'

export interface ConversationProfileCommit {
  conversationId: string
  provider: 'claude-code' | 'codex' | 'opencode'
  providerInstanceId: string
  providerSessionId: string | null
  pendingHandoffFrom?: string
  now?: number
}

export function commitConversationProfileSwitch(
  database: Database.Database,
  input: ConversationProfileCommit,
): void {
  const now = input.now ?? Date.now()
  database.transaction(() => {
    const updated = input.pendingHandoffFrom === undefined
      ? database.prepare(
          `UPDATE conversations
           SET provider_instance_id = ?, session_id = ?, updated_at = ?
           WHERE id = ?`,
        ).run(input.providerInstanceId, input.providerSessionId, now, input.conversationId)
      : database.prepare(
          `UPDATE conversations
           SET provider_instance_id = ?, session_id = ?, pending_handoff_from = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          input.providerInstanceId,
          input.providerSessionId,
          input.pendingHandoffFrom,
          now,
          input.conversationId,
        )
    if (updated.changes !== 1) throw new Error(`Conversation not found: ${input.conversationId}`)

    // A newly started target may not assign its native id until the first
    // turn. Committing the profile still has to clear the source profile's id
    // or a restart could resume the old transcript under the new credentials.
    if (!input.providerSessionId) return

    if (input.providerSessionId !== input.conversationId) {
      database.prepare(
        `INSERT OR REPLACE INTO thread_sessions
          (claude_session_id, thread_id, recorded_at)
         VALUES (?, ?, ?)`,
      ).run(input.providerSessionId, input.conversationId, now)
      database.prepare(
        'UPDATE thread_sessions SET thread_id = ? WHERE thread_id = ? AND claude_session_id != ?',
      ).run(input.conversationId, input.providerSessionId, input.providerSessionId)
    }

    const existing = database.prepare(
      `SELECT id FROM conversation_segments
       WHERE conversation_id = ? AND provider = ? AND provider_session_id = ?`,
    ).get(input.conversationId, input.provider, input.providerSessionId) as { id: string } | undefined
    if (existing) {
      database.prepare(
        `UPDATE conversation_segments
         SET provider_instance_id = ?, updated_at = ?
         WHERE id = ?`,
      ).run(input.providerInstanceId, now, existing.id)
      return
    }

    const next = database.prepare(
      'SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM conversation_segments WHERE conversation_id = ?',
    ).get(input.conversationId) as { ordinal: number }
    database.prepare(
      `INSERT INTO conversation_segments (
         id, conversation_id, provider, provider_session_id,
         provider_instance_id, ordinal, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `${input.conversationId}:${input.provider}:${input.providerSessionId}`,
      input.conversationId,
      input.provider,
      input.providerSessionId,
      input.providerInstanceId,
      next.ordinal,
      now,
      now,
    )
  })()
}
