import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { importCursorSnapshot } from '../../src/main/db/cursor-import'
import { projectManagedRootSessions } from '../../src/main/ipc/terminal-sessions'
import type { ConversationRow } from '../../src/main/db/database'

function database(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      session_id TEXT,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      sidebar_role TEXT,
      pending_handoff_from TEXT,
      origin_source TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE TABLE conversation_segments (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_session_id TEXT NOT NULL
    );
  `)
  return db
}

const first = {
  composerId: 'composer-1',
  projectPath: '/repo',
  title: 'Imported from Cursor',
  startedAt: 100,
  sourceMessageCount: 2,
  messages: [
    { id: 'cursor:composer-1:u1', role: 'user', content: 'question', timestamp: 110 },
    { id: 'cursor:composer-1:a1', role: 'assistant', content: 'answer', timestamp: 120 },
  ],
}

describe('Cursor snapshot import', () => {
  it('creates a managed Claude continuation with Cursor provenance and a pending handoff', () => {
    const db = database()
    const result = importCursorSnapshot(db, first)

    expect(result).toEqual({ conversationId: 'cursor:composer-1', refreshed: true })
    expect(db.prepare(`SELECT id, project_path, agent_type, session_id, title,
      archived, sidebar_role, pending_handoff_from, origin_source
      FROM conversations`).get()).toEqual({
      id: 'cursor:composer-1',
      project_path: '/repo',
      agent_type: 'claude-code',
      session_id: null,
      title: 'Imported from Cursor',
      archived: 0,
      sidebar_role: 'managed',
      pending_handoff_from: 'cursor',
      origin_source: 'cursor',
    })
    expect(db.prepare('SELECT id, role, content, timestamp FROM messages ORDER BY timestamp').all())
      .toEqual(first.messages)
    db.close()
  })

  it('refreshes an uncontinued snapshot idempotently', () => {
    const db = database()
    importCursorSnapshot(db, first)
    const refreshed = importCursorSnapshot(db, {
      ...first,
      title: 'Renamed in Cursor',
      sourceMessageCount: 1,
      messages: [{ id: 'cursor:composer-1:u2', role: 'user', content: 'new', timestamp: 200 }],
    })

    expect(refreshed.refreshed).toBe(true)
    expect(db.prepare('SELECT title, pending_handoff_from FROM conversations').get())
      .toEqual({ title: 'Renamed in Cursor', pending_handoff_from: 'cursor' })
    expect(db.prepare('SELECT id, content FROM messages').all())
      .toEqual([{ id: 'cursor:composer-1:u2', content: 'new' }])
    db.close()
  })

  it('refuses an empty load when Cursor advertised messages without touching the prior snapshot', () => {
    const db = database()
    importCursorSnapshot(db, first)

    expect(() => importCursorSnapshot(db, {
      ...first,
      sourceMessageCount: 2,
      messages: [],
    })).toThrow('could not be loaded')
    expect(db.prepare('SELECT id, content FROM messages ORDER BY timestamp').all()).toEqual([
      { id: 'cursor:composer-1:u1', content: 'question' },
      { id: 'cursor:composer-1:a1', content: 'answer' },
    ])
    db.close()
  })

  it('never overwrites history after a provider continuation exists', () => {
    const db = database()
    importCursorSnapshot(db, first)
    db.prepare("UPDATE conversations SET pending_handoff_from = NULL WHERE id = 'cursor:composer-1'").run()
    db.prepare(`INSERT INTO conversation_segments
      (id, conversation_id, provider, provider_session_id) VALUES (?, ?, ?, ?)`)
      .run('segment-1', 'cursor:composer-1', 'claude-code', 'native-1')

    const result = importCursorSnapshot(db, {
      ...first,
      title: 'Cursor renamed this later',
      messages: [{ id: 'cursor:composer-1:u2', role: 'user', content: 'replacement', timestamp: 200 }],
    })

    expect(result.refreshed).toBe(false)
    expect(db.prepare('SELECT id, content FROM messages ORDER BY timestamp').all()).toEqual([
      { id: 'cursor:composer-1:u1', content: 'question' },
      { id: 'cursor:composer-1:a1', content: 'answer' },
    ])
    expect(db.prepare('SELECT title, updated_at, pending_handoff_from FROM conversations').get())
      .toEqual({ title: 'Imported from Cursor', updated_at: 120, pending_handoff_from: null })
    db.close()
  })

  it('rejects a composer id already owned by another project', () => {
    const db = database()
    importCursorSnapshot(db, first)
    expect(() => importCursorSnapshot(db, { ...first, projectPath: '/other' }))
      .toThrow('another project')
    db.close()
  })

  it('rejects a same-project id collision that is not an earlier Cursor import', () => {
    const db = database()
    db.prepare(`INSERT INTO conversations
      (id, project_path, agent_type, title, created_at, updated_at, archived, sidebar_role)
      VALUES ('cursor:composer-1', '/repo', 'claude-code', 'Unrelated', 1, 1, 0, 'managed')`).run()

    expect(() => importCursorSnapshot(db, first)).toThrow('already used')
    expect(db.prepare('SELECT title, origin_source FROM conversations').get())
      .toEqual({ title: 'Unrelated', origin_source: null })
    db.close()
  })

  it('projects Cursor provenance separately from the runnable provider', () => {
    const sessions = projectManagedRootSessions([{
      id: 'cursor:composer-1',
      project_path: '/repo',
      agent_type: 'claude-code',
      origin_source: 'cursor',
      session_id: null,
      title: 'Imported from Cursor',
      created_at: 100,
      updated_at: 120,
      archived: 0,
    } as ConversationRow])

    expect(sessions).toEqual([expect.objectContaining({
      id: 'cursor:composer-1',
      source: 'cursor',
      agentType: 'claude-code',
    })])
  })
})
