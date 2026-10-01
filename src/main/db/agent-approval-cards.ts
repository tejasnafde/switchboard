import Database from 'better-sqlite3'
import type { ApprovalCardStore, HeldApprovalResult, StoredApprovalCard } from '@shared/agent-approval-cards'
import { getDb } from './database'

// ─── Agent approval cards ───────────────────────────────────────
//
// The Switchboard MCP server's open approval cards (`agent_approval_cards`),
// kept so a card the user answers an hour later survives a backend restart,
// and results the agent has not been told yet because its session was not
// running (`agent_approval_results`). Both keyed by the ROOT conversation id.
// The card's `plan` is the write an approval runs, as JSON.

export function ensureAgentApprovalCardSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_approval_cards (
      request_id      TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      thread_id       TEXT NOT NULL,
      tool_name       TEXT NOT NULL,
      detail          TEXT NOT NULL,
      host_write_json TEXT,
      plan_json       TEXT NOT NULL,
      opened_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_approval_cards_conversation
      ON agent_approval_cards(conversation_id);
    CREATE TABLE IF NOT EXISTS agent_approval_results (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      body            TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );
  `)
}

interface CardRow {
  request_id: string
  conversation_id: string
  thread_id: string
  tool_name: string
  detail: string
  host_write_json: string | null
  plan_json: string
  opened_at: number
}

export function sqliteApprovalCardStore<Plan>(open?: () => Database.Database): ApprovalCardStore<Plan> {
  const db = (): Database.Database => (open ?? getDb)()
  return {
    loadCards(): StoredApprovalCard<Plan>[] {
      const rows = db().prepare('SELECT * FROM agent_approval_cards ORDER BY opened_at').all() as CardRow[]
      return rows.map((r) => ({
        requestId: r.request_id,
        chatId: r.conversation_id,
        threadId: r.thread_id,
        toolName: r.tool_name,
        detail: r.detail,
        hostWrite: r.host_write_json ? JSON.parse(r.host_write_json) : null,
        plan: JSON.parse(r.plan_json) as Plan,
        openedAt: r.opened_at,
      }))
    },
    putCard(card) {
      db().prepare(
        `INSERT OR REPLACE INTO agent_approval_cards
           (request_id, conversation_id, thread_id, tool_name, detail, host_write_json, plan_json, opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        card.requestId, card.chatId, card.threadId, card.toolName, card.detail,
        card.hostWrite ? JSON.stringify(card.hostWrite) : null, JSON.stringify(card.plan), card.openedAt,
      )
    },
    removeCard(requestId) {
      db().prepare('DELETE FROM agent_approval_cards WHERE request_id = ?').run(requestId)
    },
    holdResult(result: HeldApprovalResult) {
      db().prepare('INSERT OR REPLACE INTO agent_approval_results (id, conversation_id, body, created_at) VALUES (?, ?, ?, ?)')
        .run(result.id, result.chatId, result.body, result.at)
    },
    takeHeldResults(chatId) {
      const d = db()
      return d.transaction(() => {
        const rows = d.prepare('SELECT id, conversation_id, body, created_at FROM agent_approval_results WHERE conversation_id = ? ORDER BY created_at')
          .all(chatId) as Array<{ id: string; conversation_id: string; body: string; created_at: number }>
        d.prepare('DELETE FROM agent_approval_results WHERE conversation_id = ?').run(chatId)
        return rows.map((r) => ({ id: r.id, chatId: r.conversation_id, body: r.body, at: r.created_at }))
      })()
    },
  }
}
