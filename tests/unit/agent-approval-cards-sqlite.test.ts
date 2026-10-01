/**
 * The SQLite store behind the approval cards: a card and a held result
 * written by one backend are read back by the next one on the same file.
 */
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ensureAgentApprovalCardSchema, sqliteApprovalCardStore } from '../../src/main/db/agent-approval-cards'
import { ApprovalCardBook, type StoredApprovalCard } from '../../src/shared/agent-approval-cards'
import type { HostWriteCard } from '../../src/shared/agent-host-writes'

const hostWrite: HostWriteCard = {
  action: 'reply', agentLabel: 'Codex', host: 'github', prLabel: 'app #1', target: { repository: 'acme/app', number: 1 },
  url: null, location: 'a.ts:3', quote: null, replyText: 'Done.', maxChars: 8000,
}

const card: StoredApprovalCard<{ kind: string; ref: { number: number } }> = {
  requestId: 'sbmcp_1', chatId: 'root', threadId: 'session-uuid', toolName: 'mcp__switchboard__reply_to_conversation',
  detail: 'Reply on app #1', hostWrite, plan: { kind: 'pr-reply', ref: { number: 1 } }, openedAt: 100,
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
    expect(new ApprovalCardBook(sqliteApprovalCardStore(() => db)).forChat('root').map((c) => c.requestId)).toEqual(['sbmcp_2'])
    expect(store.takeHeldResults('root')).toEqual([{ id: 'apr_sbmcp_0', chatId: 'root', body: 'later', at: 7 }])
    expect(store.takeHeldResults('root')).toEqual([])
    db.close()
  })
})
