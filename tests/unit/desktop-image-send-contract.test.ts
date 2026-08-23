import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureTurnAcceptanceSchema, SqliteTurnAcceptanceStore } from '../../src/main/db/turn-acceptance'
import { AtomicUserTurnSubmission } from '../../src/main/provider/durable-turn-acceptance'
import {
  createDesktopTurnAttemptRegistry,
  createDesktopPreparedTurnRegistry,
  submitDesktopUserTurn,
} from '../../src/renderer/services/desktopTurnSubmission'
import type { UserTurnSubmissionV1 } from '../../src/shared/provider-events'

function database(): Database.Database {
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
    INSERT INTO conversations VALUES ('thread-1', 'New conversation', NULL, 1);
  `)
  ensureTurnAcceptanceSchema(db)
  return db
}

function envelope(images: UserTurnSubmissionV1['images']): UserTurnSubmissionV1 {
  return {
    version: 1,
    threadId: 'thread-1',
    origin: 'desktop-origin-1',
    providerText: 'expanded provider text',
    displayBody: '[[pill:file-1]] explain these',
    pillsMeta: { 'file-1': { label: 'src/main.ts', kind: 'file' } },
    images,
    runtimeMode: 'sandbox',
    autoTitleText: 'explain these',
  }
}

describe('Desktop atomic user-turn submission', () => {
  let db: Database.Database

  beforeEach(() => {
    db = database()
  })

  it('commits seven valid images through one real submission interface', async () => {
    const events: unknown[] = []
    const dispatch = vi.fn(async () => {})
    const backend = new AtomicUserTurnSubmission({
      store: new SqliteTurnAcceptanceStore(() => db),
      publish: (event) => events.push(event),
      now: () => 100,
    })
    const images = Array.from({ length: 7 }, (_, index) => ({
      url: `data:image/png;base64,${'A'.repeat(32)}${index}A=`,
      mimeType: 'image/png',
      name: `${index}.png`,
    }))

    const result = await submitDesktopUserTurn(envelope(images), {
      startSession: vi.fn(async () => {}),
      submit: (turn) => backend.submit(turn, {
        clientScope: 'desktop',
        prepare: async () => {},
        dispatch,
      }),
    })

    expect(result).toMatchObject({ accepted: true, delivery: 'accepted' })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'user'").get())
      .toEqual({ count: 1 })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ displayBody: '[[pill:file-1]] explain these' })
  })

  it('rejects an aggregate above 3 MiB before startup and retains the attempt', async () => {
    const startSession = vi.fn(async () => {})
    const submit = vi.fn()
    const turn = envelope([{
      url: `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`,
      mimeType: 'image/png',
    }])

    const result = await submitDesktopUserTurn(turn, { startSession, submit })

    expect(result).toMatchObject({ accepted: false, delivery: 'rejected' })
    if (result.accepted) throw new Error('expected byte-limit rejection')
    expect(result.error).toContain('3 MiB')
    expect(startSession).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'user'").get())
      .toEqual({ count: 0 })
  })

  it('treats provider startup rejection as definitely unsent', async () => {
    const submit = vi.fn()
    const result = await submitDesktopUserTurn(envelope(undefined), {
      startSession: async () => { throw new Error('authentication failed') },
      submit,
    })

    expect(result).toEqual({
      accepted: false,
      delivery: 'rejected',
      error: 'Failed to start session: authentication failed',
    })
    expect(submit).not.toHaveBeenCalled()
  })

  it('keeps an acknowledgement transport failure ambiguous', async () => {
    const result = await submitDesktopUserTurn(envelope(undefined), {
      startSession: async () => {},
      submit: async () => { throw new Error('socket closed') },
    })

    expect(result).toEqual({
      accepted: false,
      delivery: 'ambiguous',
      error: 'Delivery is unconfirmed. Retry this exact turn: socket closed',
    })
  })

  it('definitely rejects an older backend without the atomic channel', async () => {
    const result = await submitDesktopUserTurn(envelope(undefined), {
      startSession: async () => {},
      submit: async () => { throw new Error('No handler: provider:submit-user-turn') },
    })

    expect(result).toEqual({
      accepted: false,
      delivery: 'rejected',
      error: 'This backend must be updated before Desktop can send an atomic user turn.',
    })
  })

  it('reuses an origin for the same recoverable composer payload only', () => {
    let sequence = 0
    const registry = createDesktopTurnAttemptRegistry(() => `origin-${++sequence}`)
    const first = registry.originFor('thread-1', 'same payload')
    const retry = registry.originFor('thread-1', 'same payload')
    const changed = registry.originFor('thread-1', 'changed payload')

    expect(retry).toBe(first)
    expect(registry.matches('thread-1', 'same payload', first)).toBe(true)
    expect(changed).not.toBe(first)
    registry.accept('thread-1', changed)
    expect(registry.originFor('thread-1', 'changed payload')).toBe('origin-3')
  })

  it('retries an ambiguous origin with its exact first prepared payload', () => {
    const registry = createDesktopPreparedTurnRegistry()
    const first = envelope(undefined)
    const changed = { ...first, providerText: 'changed while waiting' }

    expect(registry.prepare(first)).toBe(first)
    expect(registry.prepare(changed)).toBe(first)
    registry.accept(first.threadId, first.origin)
    expect(registry.prepare(changed)).toBe(changed)
  })
})
