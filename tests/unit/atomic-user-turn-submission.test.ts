import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import * as durable from '../../src/main/provider/durable-turn-acceptance'
import { SqliteTurnAcceptanceStore, ensureTurnAcceptanceSchema } from '../../src/main/db/turn-acceptance'
import type {
  RuntimeUserMessageEvent,
  UserTurnSubmissionResult,
  UserTurnSubmissionV1,
} from '../../src/shared/provider-events'

const AtomicUserTurnSubmission = (durable as unknown as {
  AtomicUserTurnSubmission: new (options: {
    store: SqliteTurnAcceptanceStore
    publish: (event: RuntimeUserMessageEvent) => void
    now?: () => number
  }) => {
    submit(input: UserTurnSubmissionV1, context: {
      clientScope: string
      prepare: () => Promise<void>
      dispatch: () => Promise<void>
    }): Promise<UserTurnSubmissionResult>
  }
}).AtomicUserTurnSubmission

describe('AtomicUserTurnSubmission', () => {
  it('commits one seven-image turn with complete display metadata', async () => {
    const harness = fixture()
    const input = submission()

    const result = await harness.service.submit(input, harness.context())

    expect(result).toMatchObject({ status: 'accepted', accepted: true, duplicate: false })
    expect(harness.dispatches).toBe(1)
    expect(harness.userRows()).toHaveLength(1)
    expect(harness.events).toHaveLength(1)
    expect(harness.events[0]).toMatchObject({
      type: 'user.message',
      origin: input.origin,
      text: input.providerText,
      displayBody: input.displayBody,
      pillsMeta: input.pillsMeta,
      images: input.images,
    })
    expect(harness.userRows()[0]).toMatchObject({
      content: input.providerText,
      display_body: input.displayBody,
      pills_meta: JSON.stringify(input.pillsMeta),
      images: JSON.stringify(input.images),
    })
    harness.close()
  })

  it('rejects an over-budget aggregate before reservation or dispatch', async () => {
    const harness = fixture()
    const images = Array.from({ length: 7 }, (_, index) => ({
      url: `data:image/png;base64,${'A'.repeat(450_000 + index)}`,
      mimeType: 'image/png',
      name: `large-${index}.png`,
    }))

    const result = await harness.service.submit(submission({ images }), harness.context())

    expect(result).toMatchObject({
      status: 'rejected',
      retryable: false,
      reason: 'Images exceed the 3 MiB synchronization limit',
    })
    expect(harness.dispatches).toBe(0)
    expect(harness.acceptanceRows()).toHaveLength(0)
    expect(harness.userRows()).toHaveLength(0)
    expect(harness.events).toHaveLength(0)
    expect(harness.db.prepare("SELECT title, updated_at FROM conversations WHERE id = 'thread-1'").get())
      .toEqual({ title: 'New conversation', updated_at: 1 })
    harness.close()
  })

  it('releases a definite pre-dispatch rejection and safely retries the same origin', async () => {
    const harness = fixture()
    let rejectPreparation = true
    const context = harness.context({
      prepare: async () => {
        if (rejectPreparation) throw new Error('checkpoint unavailable')
      },
    })

    await expect(harness.service.submit(submission(), context)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'checkpoint unavailable',
    })
    expect(harness.acceptanceRows()).toHaveLength(0)
    expect(harness.userRows()).toHaveLength(0)
    expect(harness.db.prepare("SELECT title, pending_handoff_from, updated_at FROM conversations WHERE id = 'thread-1'").get())
      .toEqual({ title: 'New conversation', pending_handoff_from: 'codex', updated_at: 1 })

    rejectPreparation = false
    await expect(harness.service.submit(submission(), context)).resolves.toMatchObject({
      status: 'accepted',
      duplicate: false,
    })
    expect(harness.dispatches).toBe(1)
    harness.close()
  })

  it('keeps post-boundary failure ambiguous and blocks a later origin', async () => {
    const harness = fixture()
    const failed = harness.context({
      dispatch: async () => {
        harness.dispatches++
        throw new Error('provider connection died')
      },
    })

    await expect(harness.service.submit(submission(), failed)).resolves.toMatchObject({
      status: 'ambiguous',
      duplicate: false,
    })
    await expect(harness.service.submit(submission(), harness.context())).resolves.toMatchObject({
      status: 'ambiguous',
      duplicate: true,
    })
    await expect(harness.service.submit(submission({ origin: 'later-question', providerText: '?' }), harness.context()))
      .resolves.toMatchObject({
        status: 'rejected',
        reason: expect.stringContaining('Earlier turn delivery is unresolved'),
      })
    expect(harness.dispatches).toBe(1)
    expect(harness.userRows()).toHaveLength(0)
    harness.close()
  })

  it('replays a canonical completed duplicate without dispatching twice', async () => {
    const harness = fixture()
    await harness.service.submit(submission(), harness.context())
    harness.now = 999

    const duplicate = await harness.service.submit(submission(), harness.context())

    expect(duplicate).toMatchObject({ status: 'accepted', duplicate: true, acceptedAt: 100 })
    expect(harness.dispatches).toBe(1)
    expect(harness.userRows()).toHaveLength(1)
    expect(harness.events).toHaveLength(2)
    expect(harness.events[1]).toEqual(harness.events[0])
    harness.close()
  })

  it('restores an accepted turn after the submitting renderer disappears before acknowledgement', async () => {
    const harness = fixture()
    const input = submission()
    await harness.service.submit(input, harness.context())

    const replayed: RuntimeUserMessageEvent[] = []
    const replacementRenderer = new AtomicUserTurnSubmission({
      store: new SqliteTurnAcceptanceStore(() => harness.db),
      publish: (event) => replayed.push(event),
      now: () => 500,
    })
    const result = await replacementRenderer.submit(input, harness.context())

    expect(result).toMatchObject({ status: 'accepted', duplicate: true, acceptedAt: 100 })
    expect(harness.dispatches).toBe(1)
    expect(harness.userRows()).toHaveLength(1)
    expect(replayed).toEqual([harness.events[0]])
    harness.close()
  })

  it('hard-conflicts when the same origin changes text or images', async () => {
    const harness = fixture()
    await harness.service.submit(submission(), harness.context())

    await expect(harness.service.submit(submission({ providerText: 'changed' }), harness.context()))
      .resolves.toMatchObject({ status: 'conflict' })
    const changedImages = submission().images?.map((image, index) =>
      index === 0 ? { ...image, url: 'data:image/png;base64,BBBB' } : image)
    await expect(harness.service.submit(submission({ images: changedImages }), harness.context()))
      .resolves.toMatchObject({ status: 'conflict' })
    expect(harness.dispatches).toBe(1)
    harness.close()
  })

  it('commits pill and handoff presentation only after provider acceptance', async () => {
    const harness = fixture()
    const input = submission({
      providerText: '<handoff>history</handoff>\n\nexpanded pill text',
      displayBody: '[[pill:file-1]] explain this',
      handoff: {
        expectedFrom: 'codex',
        markerId: 'handoff-marker',
        markerText: '[[sb:context-handoff]] Codex → Claude',
      },
    })

    const result = await harness.service.submit(input, harness.context())

    expect(harness.userRows()[0]).toMatchObject({
      content: input.providerText,
      display_body: input.displayBody,
      pills_meta: JSON.stringify(input.pillsMeta),
    })
    expect(harness.db.prepare(`SELECT content FROM messages WHERE id = 'handoff-marker'`).get()).toEqual({
      content: '[[sb:context-handoff]] Codex → Claude',
    })
    expect(harness.db.prepare(`SELECT pending_handoff_from FROM conversations WHERE id = 'thread-1'`).get())
      .toEqual({ pending_handoff_from: null })
    expect(result).toMatchObject({ conversationTitle: 'Explain these screenshots' })
    expect(harness.events[0]).toMatchObject({
      conversationTitle: 'Explain these screenshots',
      handoffMarker: {
        id: 'handoff-marker',
        text: '[[sb:context-handoff]] Codex → Claude',
      },
    })
    harness.close()
  })
})

function submission(overrides: Partial<UserTurnSubmissionV1> = {}): UserTurnSubmissionV1 {
  return {
    version: 1,
    threadId: 'thread-1',
    origin: 'origin-1',
    providerText: 'expanded provider text',
    displayBody: '[[pill:file-1]] explain this',
    pillsMeta: { 'file-1': { label: 'src/main.ts', kind: 'file' } },
    runtimeMode: 'sandbox',
    images: Array.from({ length: 7 }, (_, index) => ({
      url: `data:image/png;base64,${'A'.repeat(32 + index)}`,
      mimeType: 'image/png',
      name: `screenshot-${index + 1}.png`,
    })),
    autoTitleText: 'Explain these screenshots',
    ...overrides,
  }
}

function fixture() {
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
    INSERT INTO conversations VALUES ('thread-1', 'New conversation', 'codex', 1);
  `)
  ensureTurnAcceptanceSchema(db)
  const store = new SqliteTurnAcceptanceStore(() => db)
  const events: RuntimeUserMessageEvent[] = []
  let dispatches = 0
  let now = 100
  const service = new AtomicUserTurnSubmission({
    store,
    publish: (event) => events.push(event),
    now: () => now,
  })
  const harness = {
    db,
    service,
    events,
    get dispatches() { return dispatches },
    set dispatches(value: number) { dispatches = value },
    get now() { return now },
    set now(value: number) { now = value },
    context(overrides: Partial<{ prepare: () => Promise<void>; dispatch: () => Promise<void> }> = {}) {
      return {
        clientScope: 'desktop-scope',
        prepare: overrides.prepare ?? (async () => {}),
        dispatch: overrides.dispatch ?? (async () => { dispatches++ }),
      }
    },
    acceptanceRows: () => db.prepare('SELECT * FROM mobile_turn_acceptances').all(),
    userRows: () => db.prepare(`SELECT * FROM messages WHERE role = 'user'`).all() as Array<Record<string, unknown>>,
    close: () => db.close(),
  }
  return harness
}
