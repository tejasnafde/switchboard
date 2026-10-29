/**
 * Every writer of message text masks a live saved secret, so no row and no
 * FTS row holds it, and a fork masks the secrets of the chats it came from.
 */
import { createMigratedDb } from './helpers/test-db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/perf', () => ({ perfSpan: () => ({ end: () => {} }) }))

import { bulkSaveMessages, rewriteSystemMarker } from '../../src/main/db/database'
import { SqliteMergeBackStore } from '../../src/main/db/merge-backs'
import { SqliteTurnAcceptanceStore } from '../../src/main/db/turn-acceptance'
import { sqliteQueuedTurnRowStore } from '../../src/main/db/queued-turn-rows'
import { secretScope, maskStoredText } from '../../src/main/db/secret-mask'
import { secretMask, secretRedactor } from '../../src/main/secrets/secret-redactor'
import { clearMergedHistories, loadConversationHistory } from '../../src/main/conversations/history'
import type { MergeBackRow } from '../../src/shared/merge-back'

const VALUE = 'sbcanary_db_0123456789abcdef'
const MASK = secretMask('DB_TOKEN')

let db: ReturnType<typeof createMigratedDb>

function conversation(id: string, parent: string | null = null): void {
  db.prepare(
    "INSERT INTO conversations (id, project_path, agent_type, parent_conversation_id) VALUES (?, '/repo', 'claude-code', ?)",
  ).run(id, parent)
}

/** Every stored message and FTS row, as one string. */
function stored(): string {
  return JSON.stringify([
    db.prepare('SELECT * FROM messages').all(),
    db.prepare('SELECT content FROM messages_fts').all(),
  ])
}

beforeEach(() => {
  db = createMigratedDb()
  db.exec("INSERT INTO projects (path, name) VALUES ('/repo', 'repo')")
  conversation('chat')
  secretRedactor.add('chat', 'sec_1', 'DB_TOKEN', Buffer.from(VALUE))
})

afterEach(() => {
  secretRedactor.clear()
  clearMergedHistories()
})

describe('message writers mask a live saved secret', () => {
  it('a merge-back card, created and edited', () => {
    const store = new SqliteMergeBackStore(() => db)
    const row: MergeBackRow = {
      id: 'mb1',
      fork: 'fork',
      forkTitle: 'Fork',
      state: 'pending',
      turns: 1,
      omittedTurns: 0,
      files: [],
      moreFiles: 0,
      text: `summary with ${VALUE}`,
    }
    store.createPending({ id: 'mb1', parentId: 'chat', forkId: 'fork', row, through: { at: 1, ids: [] }, now: 1 })
    expect(stored()).toContain(MASK)
    expect(stored()).not.toContain(VALUE)
    store.editText('mb1', `edited ${VALUE}`, 2)
    expect(stored()).not.toContain(VALUE)
  })

  it('an accepted user turn and its handoff marker', () => {
    const store = new SqliteTurnAcceptanceStore(() => db)
    const key = { clientScope: 'scope', threadId: 'chat', origin: 'o1' }
    expect(store.reserve(key, 'h')).toMatchObject({ kind: 'reserved' })
    expect(store.beginDispatch(key, 'h')).toBe(true)
    db.prepare("UPDATE conversations SET pending_handoff_from = 'codex' WHERE id = 'chat'").run()
    const done = store.completeUserTurn(key, 'h', {
      messageId: 'u1',
      providerText: `use ${VALUE}`,
      displayBody: `use ${VALUE}`,
      acceptedAt: 10,
      handoff: { expectedFrom: 'codex', markerId: 'hm1', markerText: `handoff ${VALUE}` },
    })
    expect(done.completed).toBe(true)
    expect(stored()).toContain(MASK)
    expect(stored()).not.toContain(VALUE)
  })

  it('bulk saves and system marker rewrites', () => {
    bulkSaveMessages('chat', [{ id: 'b1', role: 'assistant', content: `bulk ${VALUE}`, timestamp: 1 }])
    db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES ('s1', 'chat', 'system', '[[sb:x]] a', 2)",
    ).run()
    expect(rewriteSystemMarker('chat', 's1', '[[sb:x]]', () => `[[sb:x]] ${VALUE}`)).toBe(`[[sb:x]] ${MASK}`)
    expect(stored()).not.toContain(VALUE)
  })

  it('a queued message that never ran, in its row and in what it returns', () => {
    const rows = sqliteQueuedTurnRowStore(() => db)
    rows.record({ messageId: 'q1', conversationId: 'chat', text: `queued ${VALUE}`, queuedAt: 1 })
    expect(JSON.stringify(db.prepare('SELECT * FROM queued_turn_rows').all())).not.toContain(VALUE)
    const notSent = rows.markNotSent('q1', 'stopped')
    expect(notSent?.content).toContain(MASK)
    expect(notSent?.content).not.toContain(VALUE)
    expect(stored()).not.toContain(VALUE)
  })

  it('leaves text alone when no secret is live', () => {
    secretRedactor.clear()
    expect(maskStoredText('chat', VALUE)).toBe(VALUE)
  })
})

describe('a fork masks the secrets of the chats it came from', () => {
  it('scopes a fork to its own root and every ancestor', () => {
    conversation('fork', 'chat')
    conversation('fork2', 'fork')
    expect(secretScope('fork2')).toEqual(['fork2', 'fork', 'chat'])
    expect(maskStoredText('fork2', VALUE)).toBe(MASK)
    expect(maskStoredText('unrelated', VALUE)).toBe(VALUE)
  })

  it('follows a fork chain of any depth', () => {
    let parent = 'chat'
    for (let i = 0; i < 40; i++) {
      conversation(`f${i}`, parent)
      parent = `f${i}`
    }
    expect(secretScope(parent).at(-1)).toBe('chat')
    expect(maskStoredText(parent, VALUE)).toBe(MASK)
  })

  it('turns off Accept and Reject on a changed-file card masked on read', async () => {
    secretRedactor.clear()
    const fileDiff = {
      fileEditId: 't:a.env',
      repoRoot: '/repo',
      relPath: 'a.env',
      changeKind: 'modify',
      oldContent: '',
      newContent: `TOKEN=${VALUE}`,
      status: 'pending',
    }
    db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, timestamp, attachments_json) VALUES ('d1', 'chat', 'assistant', '', 1, ?)",
    ).run(JSON.stringify({ fileDiff }))
    secretRedactor.add('chat', 'sec_1', 'DB_TOKEN', Buffer.from(VALUE))
    const history = await loadConversationHistory('chat', '/repo')
    const card = history.messages.find((m) => m.fileDiff)?.fileDiff
    expect(card).toMatchObject({ newContent: `TOKEN=${MASK}`, noRevert: 'unknown' })
    expect(history.forkMessages.find((f) => f.message.fileDiff)?.message.fileDiff?.noRevert).toBe('unknown')
  })

  it("masks the parent's value in a fork's history", async () => {
    conversation('fork', 'chat')
    // A row as the fork copied it, written before the secret was saved.
    secretRedactor.clear()
    db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES ('c1', 'fork', 'assistant', ?, 1)",
    ).run(`copied ${VALUE}`)
    secretRedactor.add('chat', 'sec_1', 'DB_TOKEN', Buffer.from(VALUE))
    const history = await loadConversationHistory('fork', '/repo')
    expect(JSON.stringify(history.messages)).toContain(MASK)
    expect(JSON.stringify([history.messages, history.forkMessages])).not.toContain(VALUE)
  })
})
