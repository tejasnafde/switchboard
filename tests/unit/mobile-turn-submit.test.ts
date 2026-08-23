/**
 * Building a turn the backend echo can collapse onto.
 *
 * Every send has to mint an origin and derive the optimistic bubble's id from
 * it. The chat store's only dedupe is id equality (`chat.ts`, case
 * 'user.message'), so a send that omits the origin gets a bubble keyed
 * `u-<phone clock>` and an echo keyed `remote_<backend clock>`, and the user
 * sees their message twice. That was the state of the phone's FIRST send: the
 * new-session screen appended the bubble with no id and called sendTurn with no
 * origin, the one send site the id-collapse change missed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { buildTurn, ownTurn } from '../../apps/mobile/src/lib/turnSubmit'
import {
  useChatStore,
  emptyThread,
  flushQueue,
  resetQueue,
  threadKey,
  type FeedItem,
} from '../../apps/mobile/src/stores/chat'
import { echoMessageId, type RuntimeEvent } from '../../src/shared/provider-events'

const CONN = 'conn-1'
const THREAD = 'thread-1'
const KEY = threadKey(CONN, THREAD)

function items(): FeedItem[] {
  return useChatStore.getState().threads[KEY]?.items ?? []
}

/** The store batches events, so a bare `ingest` proves nothing on its own. */
function ingest(event: RuntimeEvent): void {
  useChatStore.getState().ingest(CONN, event)
  flushQueue()
}

function userItems(): FeedItem[] {
  return items().filter((i) => i.kind === 'user')
}

beforeEach(() => {
  resetQueue()
  useChatStore.setState({ threads: {} })
})

afterEach(() => {
  resetQueue()
  vi.useRealTimers()
})

describe('ownTurn', () => {
  it('mints a distinct origin per call so two sends cannot share a bubble', () => {
    // Same millisecond, because a user can tap twice inside one clock tick and
    // a clock-only id would collapse the second message onto the first.
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    expect(ownTurn()).not.toBe(ownTurn())
  })
})

describe('buildTurn', () => {
  it('derives the bubble id from the origin it queues', () => {
    const turn = buildTurn({ connectionId: CONN, threadId: THREAD, text: 'hi' })
    // The whole point: these two must agree, or the echo cannot find the bubble.
    expect(turn.bubbleId).toBe(echoMessageId(turn.queued.messageId))
  })

  it('queues a message the outbox can deliver as-is', () => {
    vi.useFakeTimers()
    vi.setSystemTime(5_000)
    const turn = buildTurn({
      connectionId: CONN,
      threadId: THREAD,
      text: 'hi',
      runtimeMode: 'plan',
    })
    expect(turn.queued).toMatchObject({
      connectionId: CONN,
      threadId: THREAD,
      text: 'hi',
      runtimeMode: 'plan',
      createdAt: 5_000,
      attempts: 0,
    })
  })

  it('omits images entirely rather than queueing an empty list', () => {
    // `images: []` and `images: undefined` reach the adapter differently.
    expect(buildTurn({ connectionId: CONN, threadId: THREAD, text: 'hi' }).queued.images).toBeUndefined()
    expect(
      buildTurn({ connectionId: CONN, threadId: THREAD, text: 'hi', images: [] }).queued.images,
    ).toBeUndefined()
  })

  it('keeps images when there are some', () => {
    const images = [{ url: 'data:image/png;base64,AAA', mimeType: 'image/png' }]
    expect(buildTurn({ connectionId: CONN, threadId: THREAD, text: 'hi', images }).queued.images).toEqual(images)
  })

  it('keeps a first-turn title candidate with the durable intent', () => {
    expect(buildTurn({
      connectionId: CONN,
      threadId: THREAD,
      text: 'investigate atomic delivery',
      titleCandidate: 'investigate atomic delivery',
    }).queued.titleCandidate).toBe('investigate atomic delivery')
  })
})

describe('a built turn against the real echo', () => {
  it('does not mark a queued bubble as a running provider turn', () => {
    useChatStore.setState({ threads: { [KEY]: { ...emptyThread(), status: 'idle' } } })
    const turn = buildTurn({ connectionId: CONN, threadId: THREAD, text: 'hello' })

    useChatStore.getState().addUserMessage(KEY, 'hello', undefined, turn.bubbleId)

    expect(useChatStore.getState().threads[KEY].status).toBe('idle')
  })

  it('renders one bubble, not two, once the backend echoes it back', () => {
    const turn = buildTurn({ connectionId: CONN, threadId: THREAD, text: 'hello' })
    useChatStore.getState().addUserMessage(KEY, 'hello', undefined, turn.bubbleId)
    expect(userItems()).toHaveLength(1)

    ingest({
      type: 'user.message',
      threadId: THREAD,
      text: 'hello',
      origin: turn.queued.messageId,
      at: 9_999,
    } as RuntimeEvent)

    expect(userItems()).toHaveLength(1)
  })

  it('survives a history seed that lands while the send is in flight', () => {
    // The thread screen seeds history whenever the feed is empty OR restored
    // from disk. A send during that round trip appended a bubble but left
    // `cached` set, so the seed counted the feed as replaceable and wiped it.
    // The echo then appended a fresh copy on top of the seeded history, which
    // is the same two-bubble shape by a different route.
    useChatStore.setState({ threads: { [KEY]: { ...emptyThread(), cached: true } } })

    const turn = buildTurn({ connectionId: CONN, threadId: THREAD, text: 'hello' })
    useChatStore.getState().addUserMessage(KEY, 'hello', undefined, turn.bubbleId)

    // History arrives now, knowing nothing about the message still in flight.
    useChatStore.getState().seedItems(KEY, [{ kind: 'user', id: 'h-old', text: 'yesterday', at: 1 }], [turn.bubbleId])

    const users = userItems()
    expect(users.map((i) => i.id)).toEqual(['h-old', turn.bubbleId])

    // And the echo still collapses onto the preserved bubble.
    ingest({
      type: 'user.message',
      threadId: THREAD,
      text: 'hello',
      origin: turn.queued.messageId,
      at: 9_999,
    } as RuntimeEvent)
    expect(userItems()).toHaveLength(2)
  })

  it('does not keep a bubble the seeded history already contains', () => {
    // The delivery can succeed and the response frame still be lost, so the
    // message stays queued. After a restart the history contains it (seeded as
    // `h-<echo id>`) AND the outbox still lists it, so keeping the cached
    // bubble as well rendered the same message twice.
    useChatStore.setState({ threads: { [KEY]: { ...emptyThread(), cached: true } } })
    const turn = buildTurn({ connectionId: CONN, threadId: THREAD, text: 'hello' })
    useChatStore.getState().addUserMessage(KEY, 'hello', undefined, turn.bubbleId)

    useChatStore
      .getState()
      .seedItems(
        KEY,
        [{ kind: 'user', id: `h-${turn.bubbleId}`, text: 'hello', at: 1 }],
        [turn.bubbleId],
      )

    expect(userItems()).toHaveLength(1)
  })

  it('renders two when the origin is dropped, which is the bug being fixed', () => {
    // Pins the mechanism rather than the symptom: if this ever fails, the store
    // grew a second dedupe and buildTurn is no longer the thing holding the
    // line. Worth knowing either way.
    useChatStore.getState().addUserMessage(KEY, 'hello')
    ingest({
      type: 'user.message',
      threadId: THREAD,
      text: 'hello',
      origin: undefined,
      at: 9_999,
    } as RuntimeEvent)

    expect(userItems()).toHaveLength(2)
  })
})
