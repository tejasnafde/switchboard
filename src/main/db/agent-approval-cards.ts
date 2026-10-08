import Database from 'better-sqlite3'
import {
  formatApprovalResultMarker,
  type ApprovalCardStore,
  type HeldApprovalResult,
  type StoredApprovalCard,
} from '@shared/agent-approval-cards'
import type { HostWriteCard } from '@shared/agent-host-writes'
import { createMainLogger } from '../logger'
import { getDb } from './database'
import { saveMessageIfAbsent } from './messages'

const log = createMainLogger('db:approval-cards')

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

/** The card a row stores, or null when its JSON cannot be read back. */
function cardFromRow<Plan>(r: CardRow): StoredApprovalCard<Plan> | null {
  try {
    const plan = JSON.parse(r.plan_json) as unknown
    const hostWrite = r.host_write_json ? (JSON.parse(r.host_write_json) as unknown) : null
    if (!plan || typeof plan !== 'object' || typeof (plan as { kind?: unknown }).kind !== 'string') return null
    if (
      hostWrite !== null &&
      (typeof hostWrite !== 'object' || typeof (hostWrite as { action?: unknown }).action !== 'string')
    )
      return null
    return {
      requestId: r.request_id,
      chatId: r.conversation_id,
      threadId: r.thread_id,
      toolName: r.tool_name,
      detail: r.detail,
      hostWrite: hostWrite as HostWriteCard | null,
      plan: plan as Plan,
      openedAt: r.opened_at,
    }
  } catch (err) {
    log.warn(`approval card ${r.request_id} has unreadable JSON`, err)
    return null
  }
}

export interface SqliteApprovalCardStoreOptions {
  /** Tells a chat that one of its cards could not be read back. Default: a system row in the chat. */
  tellChat?(chatId: string, messageId: string, content: string): void
}

export function sqliteApprovalCardStore<Plan>(
  open?: () => Database.Database,
  opts: SqliteApprovalCardStoreOptions = {},
): ApprovalCardStore<Plan> {
  const db = (): Database.Database => (open ?? getDb)()
  const tellChat =
    opts.tellChat ??
    ((chatId, messageId, content) => {
      saveMessageIfAbsent(messageId, chatId, 'system', content)
    })
  return {
    /**
     * One row that cannot be read is dropped, not every card: it is deleted,
     * since nothing could ever answer it, and its chat is told it was closed.
     */
    loadCards(): StoredApprovalCard<Plan>[] {
      const rows = db().prepare('SELECT * FROM agent_approval_cards ORDER BY opened_at').all() as CardRow[]
      const cards: StoredApprovalCard<Plan>[] = []
      for (const r of rows) {
        const card = cardFromRow<Plan>(r)
        if (card) {
          cards.push(card)
          continue
        }
        log.error(`dropping unreadable approval card ${r.request_id} of ${r.conversation_id}`)
        db().prepare('DELETE FROM agent_approval_cards WHERE request_id = ?').run(r.request_id)
        try {
          tellChat(
            r.conversation_id,
            `apr_${r.request_id}`,
            formatApprovalResultMarker({
              requestId: r.request_id,
              title: 'Approval card',
              outcome: 'failed',
              text: `Switchboard could not read this approval card back after a restart, so it was closed. Nothing was sent. It asked for: ${r.detail}`,
              delivery: 'none',
            }),
          )
        } catch (err) {
          log.warn(`could not tell ${r.conversation_id} that card ${r.request_id} was dropped`, err)
        }
      }
      return cards
    },
    putCard(card) {
      db()
        .prepare(
          `INSERT OR REPLACE INTO agent_approval_cards
           (request_id, conversation_id, thread_id, tool_name, detail, host_write_json, plan_json, opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          card.requestId,
          card.chatId,
          card.threadId,
          card.toolName,
          card.detail,
          card.hostWrite ? JSON.stringify(card.hostWrite) : null,
          JSON.stringify(card.plan),
          card.openedAt,
        )
    },
    removeCard(requestId) {
      db().prepare('DELETE FROM agent_approval_cards WHERE request_id = ?').run(requestId)
    },
    holdResult(result: HeldApprovalResult) {
      db()
        .prepare(
          'INSERT OR REPLACE INTO agent_approval_results (id, conversation_id, body, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(result.id, result.chatId, result.body, result.at)
    },
    takeHeldResults(chatId) {
      const d = db()
      return d.transaction(() => {
        const rows = d
          .prepare(
            'SELECT id, conversation_id, body, created_at FROM agent_approval_results WHERE conversation_id = ? ORDER BY created_at',
          )
          .all(chatId) as Array<{ id: string; conversation_id: string; body: string; created_at: number }>
        d.prepare('DELETE FROM agent_approval_results WHERE conversation_id = ?').run(chatId)
        return rows.map((r) => ({ id: r.id, chatId: r.conversation_id, body: r.body, at: r.created_at }))
      })()
    },
  }
}
