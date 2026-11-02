/** `conversations.settled_at`: the upgrade from a database without the column, and the list projection. */
import { createMigratedDb } from './helpers/test-db'
import { describe, expect, it } from 'vitest'
import {
  clearConversationSettledForTurn,
  getConversationSettled,
  getManagedRootConversationsForProject,
  migrate,
  saveMessage,
  setConversationModel,
  setConversationSettled,
  updateConversationTitle,
} from '../../src/main/db/database'
import { projectManagedRootSessions, sessionSummaryToConversationRow } from '../../src/main/ipc/terminal-sessions'

const columns = (db: ReturnType<typeof createMigratedDb>) =>
  (db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map((c) => c.name)

describe('settled_at migration', () => {
  it('adds the column to a database from before it, keeping every row unsettled', () => {
    const db = createMigratedDb()
    db.exec('ALTER TABLE conversations DROP COLUMN settled_at')
    db.exec(
      "INSERT INTO projects (path, name) VALUES ('/r', 'r'); INSERT INTO conversations (id, project_path, title) VALUES ('c', '/r', 'Old chat')",
    )
    expect(columns(db)).not.toContain('settled_at')

    migrate(db)

    expect(columns(db)).toContain('settled_at')
    expect(db.prepare('SELECT id, title FROM conversations').all()).toEqual([{ id: 'c', title: 'Old chat' }])
    expect(getConversationSettled('c')).toBeNull()
  })

  it('runs again on a migrated database without a change', () => {
    const db = createMigratedDb()
    const before = columns(db)
    migrate(db)
    expect(columns(db)).toEqual(before)
  })
})

describe('settled time in the lists', () => {
  it('reaches the sidebar summary and the phone row, and leaves updated_at alone', () => {
    const db = createMigratedDb()
    db.exec(
      "INSERT INTO projects (path, name) VALUES ('/r', 'r'); INSERT INTO conversations (id, project_path, title, updated_at, sidebar_role) VALUES ('c', '/r', 'Chat', 100, 'managed')",
    )

    expect(setConversationSettled('c', 500)).toBe(true)

    const [session] = projectManagedRootSessions(getManagedRootConversationsForProject('/r'))
    expect(session).toMatchObject({ id: 'c', startedAt: 100, settledAt: 500 })
    expect(sessionSummaryToConversationRow(session, '/r')).toMatchObject({ settled_at: 500, updated_at: 100 })
  })
})

describe('what un-settles a chat', () => {
  const seed = () => {
    const db = createMigratedDb()
    db.exec(
      "INSERT INTO projects (path, name) VALUES ('/r', 'r'); INSERT INTO conversations (id, project_path, title, sidebar_role) VALUES ('c', '/r', 'Chat', 'managed')",
    )
    setConversationSettled('c', 500)
  }

  it('keeps a chat settled through a rename, a model change and an assistant message', () => {
    seed()
    updateConversationTitle('c', 'Renamed')
    setConversationModel('c', 'opus')
    saveMessage('m1', 'c', 'assistant', 'done')
    expect(getConversationSettled('c')).toBe(500)
  })

  it('clears the stamp when a user message starts a new turn', () => {
    seed()
    saveMessage('m2', 'c', 'user', 'one more thing')
    expect(getConversationSettled('c')).toBeNull()
  })

  it('clears the root row for a turn accepted under a rotated id', () => {
    const db = createMigratedDb()
    db.exec(
      "INSERT INTO projects (path, name) VALUES ('/r', 'r'); INSERT INTO conversations (id, project_path, title, sidebar_role) VALUES ('c', '/r', 'Chat', 'managed')",
    )
    db.exec("INSERT INTO thread_sessions (claude_session_id, thread_id) VALUES ('uuid-c', 'c')")
    setConversationSettled('c', 500)
    clearConversationSettledForTurn(db, 'uuid-c')
    expect(getConversationSettled('c')).toBeNull()
  })
})
