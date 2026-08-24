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
import { AtomicUserTurnSubmission } from '../../src/main/provider/durable-turn-acceptance'
import { commitConversationProfileSwitch } from '../../src/main/db/conversation-profile-commit'

const scratch: string[] = []

afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true })
})

describe('SqliteTurnAcceptanceStore', () => {
  it('migrates the existing acceptance table for canonical envelopes', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE mobile_turn_acceptances (
        client_scope TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        origin TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        accepted_at INTEGER NOT NULL,
        completed_at INTEGER,
        PRIMARY KEY (client_scope, thread_id, origin)
      ) WITHOUT ROWID;
    `)

    ensureTurnAcceptanceSchema(db)

    const columns = db.prepare('PRAGMA table_info(mobile_turn_acceptances)').all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'envelope_json',
      'message_id',
      'event_at',
    ]))
    db.close()
  })

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

  it('durably abandons an ambiguous turn and stops it blocking later origins', () => {
    const db = new Database(':memory:')
    ensureTurnAcceptanceSchema(db)
    const store = new SqliteTurnAcceptanceStore(() => db)
    const first = acceptanceKey({ origin: 'uncertain' })
    const second = acceptanceKey({ origin: 'next' })

    store.reserveEnvelope(first, 'hash-a', '{"turn":1}', 'remote_uncertain', 100)
    expect(store.beginDispatch(first, 'hash-a')).toBe(true)
    expect(store.resolveAmbiguous(first, 'abandon')).toEqual({
      state: 'abandoned',
      changed: true,
    })
    expect(store.resolveAmbiguous(first, 'abandon')).toEqual({
      state: 'abandoned',
      changed: false,
    })
    expect(store.reserveEnvelope(second, 'hash-b', '{"turn":2}', 'remote_next', 101))
      .toEqual({ kind: 'reserved', state: 'reserved' })
    expect(store.reserveEnvelope(first, 'hash-a', '{"turn":1}', 'remote_uncertain', 102))
      .toMatchObject({ kind: 'duplicate', state: 'abandoned' })
    db.close()
  })

  it('will not abandon a completed turn or an unknown origin', () => {
    const db = new Database(':memory:')
    ensureTurnAcceptanceSchema(db)
    const store = new SqliteTurnAcceptanceStore(() => db)
    const completed = acceptanceKey({ origin: 'done' })
    store.reserve(completed, 'hash')
    store.beginDispatch(completed, 'hash')
    store.complete(completed, 'hash')

    expect(store.resolveAmbiguous(completed, 'abandon'))
      .toEqual({ state: 'completed', changed: false })
    expect(store.resolveAmbiguous({ ...completed, origin: 'missing' }, 'abandon'))
      .toEqual({ state: 'not_found', changed: false })
    db.close()
  })

  it('abandons only the authenticated client scope when origins collide', () => {
    const db = new Database(':memory:')
    ensureTurnAcceptanceSchema(db)
    const store = new SqliteTurnAcceptanceStore(() => db)
    const scopeA = acceptanceKey({ clientScope: 'scope-a', origin: 'shared-origin' })
    const scopeB = acceptanceKey({ clientScope: 'scope-b', origin: 'shared-origin' })
    store.reserve(scopeA, 'payload-a')
    store.beginDispatch(scopeA, 'payload-a')
    store.reserve(scopeB, 'payload-b')
    store.beginDispatch(scopeB, 'payload-b')

    expect(store.resolveAmbiguous(scopeA, 'abandon')).toEqual({ state: 'abandoned', changed: true })
    expect(db.prepare(`
      SELECT client_scope, state FROM mobile_turn_acceptances ORDER BY client_scope
    `).all()).toEqual([
      { client_scope: 'scope-a', state: 'abandoned' },
      { client_scope: 'scope-b', state: 'dispatching' },
    ])
    db.close()
  })

  it('refuses abandonment while the original provider dispatch is still live', async () => {
    const db = atomicTurnDb()
    const backend = new AtomicUserTurnSubmission({
      store: new SqliteTurnAcceptanceStore(() => db),
      publish: () => {},
    })
    let rejectDispatch!: (error: Error) => void
    let dispatchEntered!: () => void
    const entered = new Promise<void>((resolve) => { dispatchEntered = resolve })
    const dispatch = new Promise<void>((_resolve, reject) => { rejectDispatch = reject })
    const turn = {
      version: 1 as const,
      threadId: 'thread-a',
      origin: 'live-dispatch',
      providerText: 'do not race this',
    }
    const submission = backend.submit(turn, {
      clientScope: 'scope-a',
      conversationId: 'thread-a',
      prepare: async () => {},
      dispatch: async () => {
        dispatchEntered()
        await dispatch
      },
    })
    await entered

    expect(backend.resolve({
      version: 1,
      threadId: 'thread-a',
      origin: 'live-dispatch',
      action: 'abandon',
    }, { clientScope: 'scope-a', conversationId: 'thread-a' })).toEqual({
      status: 'pending',
      changed: false,
      reason: 'Provider dispatch is still in progress',
    })

    rejectDispatch(new Error('connection outcome unknown'))
    await expect(submission).resolves.toMatchObject({ status: 'ambiguous' })
    expect(backend.resolve({
      version: 1,
      threadId: 'thread-a',
      origin: 'live-dispatch',
      action: 'abandon',
    }, { clientScope: 'scope-a', conversationId: 'thread-a' })).toEqual({
      status: 'abandoned',
      changed: true,
    })
    db.close()
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

  it('stages an exact envelope and blocks a different origin on the thread', () => {
    const db = atomicTurnDb()
    const store = new SqliteTurnAcceptanceStore(() => db) as SqliteTurnAcceptanceStore & {
      reserveEnvelope(
        key: TurnAcceptanceKey,
        payloadHash: string,
        envelopeJson: string,
        messageId: string,
        eventAt: number,
      ): { kind: string; state?: string; blockingOrigin?: string }
      readEnvelope(key: TurnAcceptanceKey): string | null
    }
    const first = acceptanceKey({ origin: 'first' })
    const second = acceptanceKey({ clientScope: 'scope-b', origin: 'second' })

    expect(store.reserveEnvelope(first, 'hash-first', '{"exact":true}', 'remote_first', 100)).toEqual({
      kind: 'reserved',
      state: 'reserved',
    })
    expect(store.readEnvelope(first)).toBe('{"exact":true}')
    expect(store.reserveEnvelope(second, 'hash-second', '{"later":true}', 'remote_second', 101)).toEqual({
      kind: 'blocked',
      state: 'reserved',
      blockingOrigin: 'first',
    })
    expect(db.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({ count: 0 })
    db.close()
  })

  it('treats an origin as thread-global across client scopes', () => {
    const db = atomicTurnDb()
    const store = new SqliteTurnAcceptanceStore(() => db)
    const first = acceptanceKey({ clientScope: 'desktop' })
    const pairedAgain = acceptanceKey({ clientScope: 'phone' })

    expect(store.reserveEnvelope(first, 'same-hash', '{"turn":true}', 'remote_origin-a', 100))
      .toMatchObject({ kind: 'reserved' })
    expect(store.reserveEnvelope(pairedAgain, 'same-hash', '{"turn":true}', 'remote_origin-a', 101))
      .toEqual({ kind: 'duplicate', state: 'reserved', clientScope: 'desktop' })
    expect(store.reserveEnvelope(pairedAgain, 'changed-hash', '{"turn":false}', 'remote_origin-a', 102))
      .toEqual({ kind: 'conflict', state: 'reserved' })
    db.close()
  })

  it('atomically commits the complete user row, handoff, title, and acceptance', () => {
    const db = atomicTurnDb()
    const store = new SqliteTurnAcceptanceStore(() => db) as SqliteTurnAcceptanceStore & {
      reserveEnvelope(
        key: TurnAcceptanceKey,
        payloadHash: string,
        envelopeJson: string,
        messageId: string,
        eventAt: number,
      ): { kind: string }
      completeUserTurn(
        key: TurnAcceptanceKey,
        payloadHash: string,
        turn: Record<string, unknown>,
      ): { completed: boolean; conversationTitle?: string }
    }
    const key = acceptanceKey()
    store.reserveEnvelope(key, 'hash', '{"turn":true}', 'remote_origin-a', 100)
    expect(store.beginDispatch(key, 'hash')).toBe(true)

    expect(store.completeUserTurn(key, 'hash', {
      messageId: 'remote_origin-a',
      providerText: 'expanded provider text',
      imagesJson: '[{"url":"data:image/png;base64,AA"}]',
      displayBody: '[[pill:file-1]] explain this',
      pillsMetaJson: '{"file-1":{"label":"src/main.ts","kind":"file"}}',
      acceptedAt: 200,
      autoTitle: 'Explain this',
      handoff: {
        expectedFrom: 'codex',
        markerId: 'handoff-1',
        markerText: '[[sb:context-handoff]] Codex → Claude',
      },
    })).toEqual({ completed: true, conversationTitle: 'Explain this' })

    expect(db.prepare(`
      SELECT role, content, images, display_body, pills_meta, timestamp
        FROM messages WHERE id = 'remote_origin-a'
    `).get()).toEqual({
      role: 'user',
      content: 'expanded provider text',
      images: '[{"url":"data:image/png;base64,AA"}]',
      display_body: '[[pill:file-1]] explain this',
      pills_meta: '{"file-1":{"label":"src/main.ts","kind":"file"}}',
      timestamp: 200,
    })
    expect(db.prepare(`SELECT content FROM messages WHERE id = 'handoff-1'`).get()).toEqual({
      content: '[[sb:context-handoff]] Codex → Claude',
    })
    expect(db.prepare(`SELECT title, pending_handoff_from, updated_at FROM conversations WHERE id = 'thread-a'`).get()).toEqual({
      title: 'Explain this',
      pending_handoff_from: null,
      updated_at: 200,
    })
    expect(store.reserve(key, 'hash')).toEqual({ kind: 'duplicate', state: 'completed' })
    db.close()
  })

  it('rolls back completion when a message id belongs to another thread', () => {
    const db = atomicTurnDb()
    db.exec(`
      INSERT INTO conversations VALUES ('thread-b', 'Other', NULL, 1);
      INSERT INTO messages
        (id, conversation_id, role, content, timestamp)
      VALUES ('remote_origin-a', 'thread-b', 'user', 'other turn', 1);
    `)
    const store = new SqliteTurnAcceptanceStore(() => db)
    const key = acceptanceKey()
    store.reserveEnvelope(key, 'hash', '{"turn":true}', 'remote_origin-a', 100)
    store.beginDispatch(key, 'hash')

    expect(() => store.completeUserTurn(key, 'hash', {
      messageId: 'remote_origin-a',
      providerText: 'must not overwrite',
      acceptedAt: 200,
    })).toThrow('belongs to another turn')
    expect(db.prepare("SELECT state FROM mobile_turn_acceptances WHERE origin = 'origin-a'").get())
      .toEqual({ state: 'dispatching' })
    expect(db.prepare("SELECT conversation_id, content FROM messages WHERE id = 'remote_origin-a'").get())
      .toEqual({ conversation_id: 'thread-b', content: 'other turn' })
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

function atomicTurnDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      pending_handoff_from TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls TEXT,
      images TEXT,
      timestamp INTEGER NOT NULL,
      display_body TEXT,
      pills_meta TEXT
    );
    INSERT INTO conversations VALUES ('thread-a', 'New conversation', 'codex', 1);
  `)
  ensureTurnAcceptanceSchema(db)
  return db
}
