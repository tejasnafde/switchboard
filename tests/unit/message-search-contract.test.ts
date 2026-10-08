/**
 * Message search over the app's real schema and FTS triggers: the word
 * prefix rule, punctuation that used to break the FTS query, the archive
 * rule, routing metadata for a rotated session and the display order.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { createMigratedDb } from './helpers/test-db'
import { addProject, archiveConversation, createConversation } from '../../src/main/db/database'
import { searchMessagesInDatabase } from '../../src/main/db/message-search'
import { storedTaskNoticeId } from '../../src/shared/synthetic-message'
import { SNIPPET_MARK_CLOSE, SNIPPET_MARK_OPEN } from '../../src/shared/message-search'

let db: Database.Database
let rowSeq = 0

function insert(id: string, conversationId: string, content: string, timestamp = 1_000 + rowSeq, role = 'assistant') {
  rowSeq += 1
  db.prepare('INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)')
    .run(id, conversationId, role, content, timestamp)
}

const ids = (query: string) => searchMessagesInDatabase(db, query).map((r) => r.messageId)

beforeEach(() => {
  db = createMigratedDb()
  rowSeq = 0
  addProject('/repo', 'repo')
  createConversation('t1', '/repo', 'claude-code', 'Fix sync jitter')
  createConversation('t2', '/repo', 'codex', 'Notebook engine')
})

describe('message search matching', () => {
  it('matches each word as a prefix, in any order', () => {
    insert('a1', 't1', 'The syncing worker logs the jitter it chose')
    insert('a2', 't2', 'Nothing relevant here')
    expect(ids('sync jit')).toEqual(['a1'])
    expect(ids('jitter sync')).toEqual(['a1'])
  })

  it('requires every word', () => {
    insert('a1', 't1', 'sync backoff')
    insert('a2', 't1', 'sync jitter')
    expect(ids('sync jitter')).toEqual(['a2'])
  })

  it.each([
    ['fix-jitter', 'a1'],
    ['"jitter"', 'a1'],
    ['(jitter OR', 'a1'],
    ['jitter AND NOT', 'a1'],
    ['C:\\jitter', 'a2'],
    ['foo.ts', 'a3'],
    ['^jitter*', 'a1'],
    ['fix:jitter', 'a1'],
    ['NEAR(jitter', 'a1'],
  ])('searches the words of %s without an FTS syntax error', (query, expected) => {
    insert('a1', 't1', 'fix the jitter now')
    insert('a2', 't1', 'path C:\\jitter\\file')
    insert('a3', 't2', 'edit foo.ts please')
    const results = searchMessagesInDatabase(db, query)
    expect(results.map((r) => r.messageId)).toContain(expected)
    // Only the FTS path ranks rows; the LIKE fallback does not.
    expect(results.every((r) => typeof r.rank === 'number')).toBe(true)
  })

  it('returns nothing for a query with no words', () => {
    insert('a1', 't1', 'anything')
    expect(searchMessagesInDatabase(db, '"* - ()')).toEqual([])
    expect(searchMessagesInDatabase(db, 'AND OR')).toEqual([])
  })

  it('highlights matches with control markers that markdown cannot produce', () => {
    insert('a1', 't1', 'a **bold** word and the jitter')
    const [hit] = searchMessagesInDatabase(db, 'jitter')
    expect(hit.snippetMarked).toContain(`${SNIPPET_MARK_OPEN}jitter${SNIPPET_MARK_CLOSE}`)
    expect(hit.snippet).toContain('**jitter**')
  })

  it('scans the messages when the FTS index itself fails', () => {
    insert('a1', 't1', 'fix the jitter now')
    insert('a2', 't1', 'fix only')
    db.exec('DROP TABLE messages_fts')
    const results = searchMessagesInDatabase(db, 'fix jitter')
    expect(results.map((r) => r.messageId)).toEqual(['a1'])
    expect(results[0].rank).toBeUndefined()
  })

  it('leaves stored task notices out of the results', () => {
    insert('a1', 't1', 'The build failed with exit code 2')
    insert(storedTaskNoticeId('t1', 'task_u1'), 't1', '<task-notification>\n<status>failed</status>\n<summary>Build failed</summary>\n</task-notification>', 2_000, 'user')
    expect(ids('failed')).toEqual(['a1'])
  })
})

describe('message search result fields', () => {
  it('names the chat, project, agent and time, routed to the root thread', () => {
    db.prepare('INSERT INTO conversations (id, project_path, agent_type, title, sidebar_role) VALUES (?, ?, ?, ?, ?)')
      .run('rotated', '/repo', 'claude-code', 'stale', 'recovery')
    db.prepare('INSERT INTO thread_sessions (thread_id, claude_session_id) VALUES (?, ?)').run('t1', 'rotated')
    insert('a1', 'rotated', 'the durable needle', 5_000)
    const [hit] = searchMessagesInDatabase(db, 'needle')
    expect(hit).toMatchObject({
      messageId: 'a1',
      conversationId: 't1',
      conversationTitle: 'Fix sync jitter',
      projectPath: '/repo',
      agentType: 'claude-code',
      timestamp: 5_000,
      archived: false,
      phraseMatch: true,
    })
    expect(typeof hit.rank).toBe('number')
  })
})

describe('archived chats', () => {
  beforeEach(() => {
    insert('live', 't1', 'deploy notes')
    insert('old', 't2', 'deploy notes')
    archiveConversation('t2')
  })

  it('are left out by default', () => {
    expect(ids('deploy')).toEqual(['live'])
  })

  it.each(['archived deploy', 'deploy Archive', 'ARCHIVED deploy'])('are included and marked for %s', (query) => {
    const results = searchMessagesInDatabase(db, query)
    expect(results.map((r) => r.messageId).sort()).toEqual(['live', 'old'])
    expect(results.find((r) => r.messageId === 'old')?.archived).toBe(true)
    expect(results.find((r) => r.messageId === 'live')?.archived).toBe(false)
  })

  it('do not search for the word archived itself', () => {
    insert('word', 't1', 'the archived flag')
    expect(ids('archived deploy')).not.toContain('word')
  })
})

describe('message search order', () => {
  it('puts an exact phrase match above scattered words', () => {
    insert('scattered', 't1', 'sync the files, then measure the jitter', 9_000)
    insert('phrase', 't2', 'the sync jitter is fixed in the worker today', 1_000)
    expect(ids('sync jitter')).toEqual(['phrase', 'scattered'])
  })

  it('puts the newer message first among equally relevant ones', () => {
    insert('older', 't1', 'restart the queue worker', 1_000)
    insert('newer', 't2', 'restart the queue worker', 2_000)
    expect(ids('queue')).toEqual(['newer', 'older'])
  })

  it('keeps clearly more relevant messages above newer ones', () => {
    insert('dense', 't1', 'cache cache cache', 1_000)
    insert('sparse', 't2', `cache ${'filler words that dilute the match '.repeat(30)}`, 9_000)
    expect(ids('cache')).toEqual(['dense', 'sparse'])
  })
})
