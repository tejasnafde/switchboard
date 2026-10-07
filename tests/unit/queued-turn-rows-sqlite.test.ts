/**
 * A queued message's chat row is stored when it is queued. One that never
 * runs must not read as sent: its row becomes an error row with its text.
 */
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ensureQueuedTurnRowsSchema, sqliteQueuedTurnRowStore } from '../../src/main/db/queued-turn-rows'

function setup() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', timestamp INTEGER NOT NULL);
    INSERT INTO conversations VALUES ('chat');
    INSERT INTO messages VALUES ('remote_q1', 'chat', 'user', 'run the tests', 10);
    INSERT INTO messages VALUES ('remote_q2', 'chat', 'user', 'then deploy', 11);
  `)
  ensureQueuedTurnRowsSchema(db)
  ensureQueuedTurnRowsSchema(db)
  return { db, store: sqliteQueuedTurnRowStore(() => db) }
}

const rows = (db: Database.Database) => db.prepare('SELECT id, role, content FROM messages ORDER BY timestamp, id').all()

describe('sqliteQueuedTurnRowStore', () => {
  it('replaces a dropped message with an error row that keeps its text', () => {
    const { db, store } = setup()
    store.record({ messageId: 'remote_q1', conversationId: 'chat', text: 'run the tests', queuedAt: 10 })
    const notSent = store.markNotSent('remote_q1', 'stopped')
    expect(notSent?.content).toContain('the session stopped before it ran')
    expect(rows(db)).toEqual([
      { id: 'queued_not_sent_remote_q1', role: 'system', content: notSent!.content },
      { id: 'remote_q2', role: 'user', content: 'then deploy' },
    ])
    expect(notSent!.content.startsWith('Error: ')).toBe(true)
    expect(notSent!.content.endsWith('run the tests')).toBe(true)
    // Only once.
    expect(store.markNotSent('remote_q1', 'stopped')).toBeNull()
  })

  it('leaves a message that ran alone', () => {
    const { db, store } = setup()
    store.record({ messageId: 'remote_q1', conversationId: 'chat', text: 'run the tests', queuedAt: 10 })
    store.forget('remote_q1')
    expect(store.markNotSent('remote_q1', 'stopped')).toBeNull()
    expect(store.sweepEarlierLaunches()).toEqual([])
    expect(rows(db)).toHaveLength(2)
  })

  it('after a restart, converts only what an earlier process held', () => {
    const { db, store } = setup()
    store.record({ messageId: 'remote_q2', conversationId: 'chat', text: 'then deploy', queuedAt: 11 })
    db.prepare("INSERT INTO queued_turn_rows VALUES ('remote_q1', 'chat', 'run the tests', 10, 'earlier')").run()
    const swept = store.sweepEarlierLaunches()
    expect(swept.map((r) => r.messageId)).toEqual(['remote_q1'])
    expect(swept[0].content).toContain('Switchboard restarted before it ran')
    expect(rows(db).map((r) => (r as { id: string }).id)).toEqual(['queued_not_sent_remote_q1', 'remote_q2'])
    expect(store.sweepEarlierLaunches()).toEqual([])
  })
})
