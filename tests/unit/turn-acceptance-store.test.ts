import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SqliteTurnAcceptanceStore,
  ensureTurnAcceptanceSchema,
  recoverUndispatchedTurns,
  type TurnAcceptanceKey,
} from '../../src/main/db/turn-acceptance'
import { commitConversationProfileSwitch } from '../../src/main/db/conversation-profile-commit'

const scratch: string[] = []

afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true })
})

describe('SqliteTurnAcceptanceStore', () => {
  it('atomically reserves and lets only one caller enter dispatch', () => {
    const db = new Database(':memory:')
    ensureTurnAcceptanceSchema(db)
    const store = new SqliteTurnAcceptanceStore(() => db)
    const key = acceptanceKey()

    expect(store.reserve(key, 'payload-a')).toEqual({ kind: 'reserved', state: 'reserved' })
    expect(store.reserve(key, 'payload-a')).toEqual({ kind: 'duplicate', state: 'reserved' })
    expect(store.beginDispatch(key, 'payload-a')).toBe(true)
    expect(store.beginDispatch(key, 'payload-a')).toBe(false)
    expect(store.reserve(key, 'payload-a')).toEqual({ kind: 'duplicate', state: 'dispatching' })
    db.close()
  })

  it('releases an undispatched reservation after a backend process restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-turn-accept-'))
    scratch.push(dir)
    const path = join(dir, 'switchboard.db')
    const first = new Database(path)
    ensureTurnAcceptanceSchema(first)
    new SqliteTurnAcceptanceStore(() => first).reserve(acceptanceKey(), 'payload-a')
    first.close()

    const reopened = new Database(path)
    recoverUndispatchedTurns(reopened)
    const result = new SqliteTurnAcceptanceStore(() => reopened).reserve(acceptanceKey(), 'payload-a')

    expect(result).toEqual({ kind: 'reserved', state: 'reserved' })
    reopened.close()
  })

  it('keeps a dispatching turn ambiguous after a backend process restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-turn-accept-'))
    scratch.push(dir)
    const path = join(dir, 'switchboard.db')
    const first = new Database(path)
    ensureTurnAcceptanceSchema(first)
    const firstStore = new SqliteTurnAcceptanceStore(() => first)
    firstStore.reserve(acceptanceKey(), 'payload-a')
    firstStore.beginDispatch(acceptanceKey(), 'payload-a')
    first.close()

    const reopened = new Database(path)
    recoverUndispatchedTurns(reopened)
    const result = new SqliteTurnAcceptanceStore(() => reopened).reserve(acceptanceKey(), 'payload-a')

    expect(result).toEqual({ kind: 'duplicate', state: 'dispatching' })
    reopened.close()
  })

  it('scopes equal origins by client and thread', () => {
    const db = new Database(':memory:')
    ensureTurnAcceptanceSchema(db)
    const store = new SqliteTurnAcceptanceStore(() => db)

    expect(store.reserve(acceptanceKey(), 'payload')).toMatchObject({ kind: 'reserved' })
    expect(store.reserve(acceptanceKey({ clientScope: 'scope-b' }), 'payload')).toMatchObject({ kind: 'reserved' })
    expect(store.reserve(acceptanceKey({ threadId: 'thread-b' }), 'payload')).toMatchObject({ kind: 'reserved' })
    db.close()
  })

  it('rejects origin reuse with a different payload', () => {
    const db = new Database(':memory:')
    ensureTurnAcceptanceSchema(db)
    const store = new SqliteTurnAcceptanceStore(() => db)
    const key = acceptanceKey()
    store.reserve(key, 'payload-a')

    expect(store.reserve(key, 'payload-b')).toEqual({ kind: 'conflict', state: 'reserved' })
    db.close()
  })

  it('completes accepted dispatches and releases only definite rejections', () => {
    const db = new Database(':memory:')
    ensureTurnAcceptanceSchema(db)
    const store = new SqliteTurnAcceptanceStore(() => db)
    const complete = acceptanceKey({ origin: 'complete' })
    store.reserve(complete, 'payload')
    store.beginDispatch(complete, 'payload')
    store.complete(complete, 'payload')
    expect(store.reserve(complete, 'payload')).toEqual({ kind: 'duplicate', state: 'completed' })

    const retryable = acceptanceKey({ origin: 'retryable' })
    store.reserve(retryable, 'payload')
    store.beginDispatch(retryable, 'payload')
    expect(store.release(retryable, 'payload')).toBe(true)
    expect(store.reserve(retryable, 'payload')).toEqual({ kind: 'reserved', state: 'reserved' })
    db.close()
  })
})

describe('commitConversationProfileSwitch', () => {
  function profileDb(): Database.Database {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        provider_instance_id TEXT,
        session_id TEXT,
        pending_handoff_from TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE conversation_segments (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        provider_instance_id TEXT,
        ordinal INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(conversation_id, provider, provider_session_id)
      );
      CREATE TABLE thread_sessions (
        claude_session_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
      );
      INSERT INTO conversations VALUES ('root', 'work', 'native-old', NULL, 1);
    `)
    return db
  }

  it('commits profile identity, native session, segment, and legacy mapping atomically', () => {
    const db = profileDb()

    commitConversationProfileSwitch(db, {
      conversationId: 'root',
      provider: 'claude-code',
      providerInstanceId: 'personal',
      providerSessionId: 'native-new',
      now: 20,
    })

    expect(db.prepare('SELECT provider_instance_id, session_id FROM conversations WHERE id = ?')
      .get('root')).toEqual({ provider_instance_id: 'personal', session_id: 'native-new' })
    expect(db.prepare('SELECT provider, provider_session_id, provider_instance_id, ordinal FROM conversation_segments')
      .get()).toEqual({
        provider: 'claude-code',
        provider_session_id: 'native-new',
        provider_instance_id: 'personal',
        ordinal: 0,
      })
    expect(db.prepare('SELECT thread_id FROM thread_sessions WHERE claude_session_id = ?')
      .get('native-new')).toEqual({ thread_id: 'root' })
    db.close()
  })

  it('rolls back the conversation selection when segment persistence fails', () => {
    const db = profileDb()
    db.exec(`
      CREATE TRIGGER fail_profile_segment
      BEFORE INSERT ON conversation_segments
      BEGIN
        SELECT RAISE(ABORT, 'segment failed');
      END;
    `)

    expect(() => commitConversationProfileSwitch(db, {
      conversationId: 'root',
      provider: 'codex',
      providerInstanceId: 'personal',
      providerSessionId: 'native-new',
      now: 20,
    })).toThrow(/segment failed/)

    expect(db.prepare('SELECT provider_instance_id, session_id FROM conversations WHERE id = ?')
      .get('root')).toEqual({ provider_instance_id: 'work', session_id: 'native-old' })
    expect(db.prepare('SELECT count(*) AS count FROM conversation_segments').get()).toEqual({ count: 0 })
    db.close()
  })

  it('commits a fresh target profile while clearing the stale native session id', () => {
    const db = profileDb()

    commitConversationProfileSwitch(db, {
      conversationId: 'root',
      provider: 'claude-code',
      providerInstanceId: 'personal',
      providerSessionId: null,
      pendingHandoffFrom: 'claude-code',
      now: 20,
    })

    expect(db.prepare('SELECT provider_instance_id, session_id, pending_handoff_from FROM conversations WHERE id = ?')
      .get('root')).toEqual({
        provider_instance_id: 'personal',
        session_id: null,
        pending_handoff_from: 'claude-code',
      })
    expect(db.prepare('SELECT count(*) AS count FROM conversation_segments').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT count(*) AS count FROM thread_sessions').get()).toEqual({ count: 0 })
    db.close()
  })
})

function acceptanceKey(overrides: Partial<TurnAcceptanceKey> = {}): TurnAcceptanceKey {
  return {
    clientScope: 'scope-a',
    threadId: 'thread-a',
    origin: 'origin-a',
    ...overrides,
  }
}
