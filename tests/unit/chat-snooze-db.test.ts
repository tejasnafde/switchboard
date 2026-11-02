/** `conversations` snooze columns: the upgrade, the root-row rule, and every write that ends a snooze. */
import { createMigratedDb } from './helpers/test-db'
import { describe, expect, it } from 'vitest'
import {
  clearConversationInboxForTurn,
  clearConversationWoke,
  getConversationSnooze,
  getManagedRootConversationsForProject,
  listSnoozedConversations,
  migrate,
  saveMessage,
  setConversationSettled,
  setConversationSnooze,
  wakeConversation,
} from '../../src/main/db/database'
import { projectManagedRootSessions, sessionSummaryToConversationRow } from '../../src/main/ipc/terminal-sessions'

const SNOOZE_COLUMNS = [
  'snoozed_until',
  'snoozed_at',
  'snooze_pr',
  'snooze_pr_mark',
  'snooze_rev',
  'woke_at',
  'woke_reason',
]

const columns = (db: ReturnType<typeof createMigratedDb>) =>
  (db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map((c) => c.name)

/** A chat `c` whose rotated session id is `uuid-c`. */
function seed() {
  const db = createMigratedDb()
  db.exec(
    "INSERT INTO projects (path, name) VALUES ('/r', 'r'); INSERT INTO conversations (id, project_path, title, updated_at, sidebar_role) VALUES ('c', '/r', 'Chat', 100, 'managed')",
  )
  db.exec("INSERT INTO thread_sessions (claude_session_id, thread_id) VALUES ('uuid-c', 'c')")
  return db
}

const snooze = (id: string, until: number | null, extra: { pr?: string; expectRev?: number } = {}) =>
  setConversationSnooze(id, { until, pr: extra.pr ?? null, prMark: null, at: 50, expectRev: extra.expectRev })

describe('snooze migration', () => {
  it('adds the columns to a database from before them, keeping every row unsnoozed', () => {
    const db = createMigratedDb()
    db.exec('DROP INDEX idx_conversations_snoozed')
    for (const c of SNOOZE_COLUMNS) db.exec(`ALTER TABLE conversations DROP COLUMN ${c}`)
    db.exec(
      "INSERT INTO projects (path, name) VALUES ('/r', 'r'); INSERT INTO conversations (id, project_path, title) VALUES ('c', '/r', 'Old chat')",
    )
    migrate(db)
    expect(columns(db)).toEqual(expect.arrayContaining(SNOOZE_COLUMNS))
    expect(getConversationSnooze('c')).toMatchObject({ snoozedAt: null, snoozeRev: 0, wokeAt: null })
    expect(listSnoozedConversations()).toEqual([])
  })

  it('runs again on a migrated database without a change', () => {
    const db = createMigratedDb()
    const before = columns(db)
    migrate(db)
    expect(columns(db)).toEqual(before)
  })
})

describe('snooze writes', () => {
  it('writes and reads the root row through a rotated id', () => {
    seed()
    expect(snooze('uuid-c', 9000)).toBe(1)
    expect(getConversationSnooze('c')).toMatchObject({ snoozedUntil: 9000, snoozedAt: 50, snoozeRev: 1 })
    expect(getConversationSnooze('uuid-c')).toMatchObject({ snoozedUntil: 9000 })
    expect(listSnoozedConversations()).toEqual([
      { id: 'c', snoozedUntil: 9000, snoozePr: null, snoozePrMark: null, snoozeRev: 1 },
    ])
  })

  it('reaches the sidebar summary and the phone row', () => {
    seed()
    snooze('c', 9000, { pr: 'a/b#5' })
    const [session] = projectManagedRootSessions(getManagedRootConversationsForProject('/r'))
    expect(session).toMatchObject({
      snoozedUntil: 9000,
      snoozedAt: 50,
      snoozePr: 'a/b#5',
      snoozeRev: 1,
      startedAt: 100,
    })
    expect(sessionSummaryToConversationRow(session, '/r')).toMatchObject({ snoozed_until: 9000, snooze_pr: 'a/b#5' })
  })

  it('refuses a write at a revision that moved', () => {
    seed()
    snooze('c', 9000)
    expect(snooze('c', 9500, { expectRev: 0 })).toBeNull()
    expect(snooze('c', 9500, { expectRev: 1 })).toBe(2)
  })

  it('a marked wake clears every snooze field together and keeps the marker apart', () => {
    seed()
    snooze('c', 9000, { pr: 'a/b#5' })
    expect(wakeConversation('uuid-c', 'time', 9001, 1)).toBe(true)
    expect(getConversationSnooze('c')).toEqual({
      snoozedUntil: null,
      snoozedAt: null,
      snoozePr: null,
      snoozePrMark: null,
      snoozeRev: 2,
      wokeAt: 9001,
      wokeReason: 'time',
    })
    // Seen drops the marker and never brings the snooze back.
    expect(clearConversationWoke('uuid-c')).toBe(true)
    expect(getConversationSnooze('c')).toMatchObject({ snoozedAt: null, wokeAt: null, snoozeRev: 2 })
    expect(clearConversationWoke('c')).toBe(false)
  })

  it('Wake now leaves no marker, and a wake at an old revision does nothing', () => {
    seed()
    snooze('c', 9000)
    expect(wakeConversation('c', 'time', 9001, 0)).toBe(false)
    expect(wakeConversation('c', 'wake_now', 9001)).toBe(true)
    expect(getConversationSnooze('c')).toMatchObject({ snoozedAt: null, wokeAt: null })
    expect(wakeConversation('c', 'wake_now', 9002)).toBe(false)
  })

  it('a new snooze clears the Woke marker', () => {
    seed()
    snooze('c', 9000)
    wakeConversation('c', 'needs_you', 9001)
    snooze('c', 12000)
    expect(getConversationSnooze('c')).toMatchObject({ snoozedAt: 50, wokeAt: null, wokeReason: null })
  })
})

describe('what ends a snooze', () => {
  it('a user message, with its marker', () => {
    seed()
    snooze('c', 9000)
    saveMessage('m1', 'c', 'user', 'one more thing')
    expect(getConversationSnooze('c')).toMatchObject({ snoozedAt: null, snoozeRev: 2 })
  })

  it('a turn accepted under a rotated id, and the Woke marker with it', () => {
    const db = seed()
    snooze('c', 9000)
    wakeConversation('c', 'time', 9001)
    clearConversationInboxForTurn(db, 'uuid-c')
    expect(getConversationSnooze('c')).toMatchObject({ snoozedAt: null, wokeAt: null })
  })

  it('not an assistant message', () => {
    seed()
    snooze('c', 9000)
    saveMessage('m1', 'c', 'assistant', 'done')
    expect(getConversationSnooze('c')).toMatchObject({ snoozedAt: 50 })
  })

  it('a settle, durably, with the marker; an unsettle leaves a new snooze alone', () => {
    seed()
    snooze('c', 9000)
    setConversationSettled('uuid-c', 700)
    expect(getConversationSnooze('c')).toMatchObject({ snoozedAt: null, snoozeRev: 2, wokeAt: null })
    setConversationSettled('c', 800)
    expect(getConversationSnooze('c')).toMatchObject({ snoozeRev: 2 })
    snooze('c', 9000)
    setConversationSettled('c', null)
    expect(getConversationSnooze('c')).toMatchObject({ snoozedAt: 50 })
  })
})
