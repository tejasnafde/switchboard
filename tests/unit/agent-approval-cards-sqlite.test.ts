/**
 * The SQLite store behind the approval cards: a card and a held result
 * written by one backend are read back by the next one on the same file.
 */
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ensureAgentApprovalCardSchema, sqliteApprovalCardStore } from '../../src/main/db/agent-approval-cards'
import {
  ApprovalCardBook,
  parseApprovalResultMarker,
  type StoredApprovalCard,
} from '../../src/shared/agent-approval-cards'
import type { HostWriteCard } from '../../src/shared/agent-host-writes'

const hostWrite: HostWriteCard = {
  action: 'reply',
  agentLabel: 'Codex',
  host: 'github',
  prLabel: 'app #1',
  target: { repository: 'acme/app', number: 1 },
  url: null,
  location: 'a.ts:3',
  quote: null,
  replyText: 'Done.',
  maxChars: 8000,
}

const card: StoredApprovalCard<{ kind: string; ref: { number: number } }> = {
  requestId: 'sbmcp_1',
  chatId: 'root',
  threadId: 'session-uuid',
  toolName: 'mcp__switchboard__reply_to_conversation',
  detail: 'Reply on app #1',
  hostWrite,
  plan: { kind: 'pr-reply', ref: { number: 1 } },
  openedAt: 100,
}

describe('sqliteApprovalCardStore', () => {
  it('reads back the cards and held results another process wrote, and forgets what was taken', () => {
    const db = new Database(':memory:')
    ensureAgentApprovalCardSchema(db)
    ensureAgentApprovalCardSchema(db)
    const store = sqliteApprovalCardStore<typeof card.plan>(() => db)
    const book = new ApprovalCardBook(store)
    book.add(card)
    book.add({ ...card, requestId: 'sbmcp_2', hostWrite: null, openedAt: 50 })
    store.holdResult({ id: 'apr_sbmcp_0', chatId: 'root', body: 'later', at: 7 })

    const restarted = new ApprovalCardBook(sqliteApprovalCardStore<typeof card.plan>(() => db))
    expect(restarted.forChat('root')).toEqual([{ ...card, requestId: 'sbmcp_2', hostWrite: null, openedAt: 50 }, card])
    restarted.take('sbmcp_1')
    expect(new ApprovalCardBook(sqliteApprovalCardStore(() => db)).forChat('root').map((c) => c.requestId)).toEqual([
      'sbmcp_2',
    ])
    expect(store.takeHeldResults('root')).toEqual([{ id: 'apr_sbmcp_0', chatId: 'root', body: 'later', at: 7 }])
    expect(store.takeHeldResults('root')).toEqual([])
    db.close()
  })

  it('drops only an unreadable row: deleted, and its chat told, while every other card loads', () => {
    const db = new Database(':memory:')
    ensureAgentApprovalCardSchema(db)
    const told: Array<{ chatId: string; messageId: string; content: string }> = []
    const store = sqliteApprovalCardStore<typeof card.plan>(() => db, {
      tellChat: (chatId, messageId, content) => told.push({ chatId, messageId, content }),
    })
    const book = new ApprovalCardBook(store)
    book.add(card)
    book.add({ ...card, requestId: 'sbmcp_3', openedAt: 300 })
    db.prepare(
      `INSERT INTO agent_approval_cards VALUES ('sbmcp_bad', 'other', 't', 'x', 'Reply on app #9', NULL, '{not json', 200)`,
    ).run()
    db.prepare(
      `INSERT INTO agent_approval_cards VALUES ('sbmcp_kindless', 'other', 't', 'x', 'd', NULL, '{}', 250)`,
    ).run()

    const restarted = new ApprovalCardBook(store)
    expect(restarted.all().map((c) => c.requestId)).toEqual(['sbmcp_1', 'sbmcp_3'])
    expect(db.prepare('SELECT request_id FROM agent_approval_cards ORDER BY opened_at').all()).toEqual([
      { request_id: 'sbmcp_1' },
      { request_id: 'sbmcp_3' },
    ])
    expect(told.map((t) => [t.chatId, t.messageId])).toEqual([
      ['other', 'apr_sbmcp_bad'],
      ['other', 'apr_sbmcp_kindless'],
    ])
    expect(parseApprovalResultMarker(told[0].content)).toMatchObject({
      requestId: 'sbmcp_bad',
      outcome: 'failed',
      delivery: 'none',
    })
    expect(told[0].content).toContain('Reply on app #9')
    db.close()
  })
})
