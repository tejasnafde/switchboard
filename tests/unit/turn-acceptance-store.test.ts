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

function acceptanceKey(overrides: Partial<TurnAcceptanceKey> = {}): TurnAcceptanceKey {
  return {
    clientScope: 'scope-a',
    threadId: 'thread-a',
    origin: 'origin-a',
    ...overrides,
  }
}
