/**
 * First tests for the mobile chat store. Covers the two device-found bugs
 * (streamed text duplicating, tool spinners never settling) and the event
 * coalescing that keeps a phone from rendering once per token.
 */
import { echoMessageId } from '../../src/shared/provider-events'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  useChatStore,
  flushQueue,
  resetQueue,
  threadKey,
  type FeedItem,
} from '../../apps/mobile/src/stores/chat'
import type { RuntimeEvent } from '../../src/shared/provider-events'

const CONN = 'conn-1'
const THREAD = 'thread-1'
const KEY = threadKey(CONN, THREAD)

function content(text: string, messageId = 'msg-1'): RuntimeEvent {
  return { type: 'content', threadId: THREAD, messageId, streamKind: 'assistant', text } as RuntimeEvent
}

function items(): FeedItem[] {
  return useChatStore.getState().threads[KEY]?.items ?? []
}

function ingest(e: RuntimeEvent): void {
  useChatStore.getState().ingest(CONN, e)
}

beforeEach(() => {
  vi.useFakeTimers()
  resetQueue()
  useChatStore.setState({ threads: {}, activeKey: KEY })
})

afterEach(() => {
  resetQueue()
  vi.useRealTimers()
})

describe('content events replace rather than append', () => {
  it('keeps the latest accumulated text instead of concatenating deltas', () => {
    // Adapters emit the FULL accumulated text per delta, so appending produced
    // "HeHelHello" on the device.
    ingest(content('He'))
    ingest(content('Hel'))
    ingest(content('Hello'))
    flushQueue()

    const text = items().filter((i) => i.kind === 'text')
    expect(text).toHaveLength(1)
    expect(text[0]).toMatchObject({ text: 'Hello' })
  })

  it('keeps separate messages separate', () => {
    ingest(content('first', 'msg-1'))
    ingest(content('second', 'msg-2'))
    flushQueue()

    expect(items().filter((i) => i.kind === 'text').map((i) => (i as { text: string }).text)).toEqual([
      'first',
      'second',
    ])
  })
})

describe('coalescing', () => {
  it('applies a burst of deltas in a single store write', () => {
    let writes = 0
    const unsub = useChatStore.subscribe(() => {
      writes++
    })
    for (let i = 0; i < 50; i++) ingest(content('x'.repeat(i + 1)))
    expect(writes).toBe(0) // nothing applied yet - still queued

    vi.advanceTimersByTime(60)
    unsub()

    expect(writes).toBe(1)
    expect((items()[0] as { text: string }).text).toBe('x'.repeat(50))
  })

  it('preserves order when tool events interleave with deltas', () => {
    ingest(content('thinking'))
    ingest({ type: 'tool.started', threadId: THREAD, toolId: 'a', toolName: 'Bash', input: {} } as RuntimeEvent)
    ingest(content('thinking more')) // collapses into the earlier delta in place
    flushQueue()

    expect(items().map((i) => i.kind)).toEqual(['text', 'tool'])
    expect((items()[0] as { text: string }).text).toBe('thinking more')
  })

  it('flushes immediately for events a human is waiting on', () => {
    ingest(content('partial'))
    ingest({
      type: 'request.opened',
      threadId: THREAD,
      requestId: 'r1',
      toolName: 'Write',
      detail: 'file.ts',
      requestType: 'tool',
    } as RuntimeEvent)

    // No timer advance: the approval must already be on screen, and the text
    // queued ahead of it must not have been reordered behind it.
    expect(items().map((i) => i.kind)).toEqual(['text', 'approval'])
  })
})

describe('turn.completed settles in-flight cards', () => {
  it('stops a tool spinner even when tool.completed never arrived', () => {
    ingest({ type: 'tool.started', threadId: THREAD, toolId: 'a', toolName: 'Bash', input: {} } as RuntimeEvent)
    flushQueue()
    expect((items()[0] as { state: string }).state).toBe('running')

    ingest({ type: 'turn.completed', threadId: THREAD, durationMs: 1200 } as RuntimeEvent)
    flushQueue()

    expect((items()[0] as { state: string }).state).toBe('done')
    expect(useChatStore.getState().threads[KEY].status).toBe('idle')
  })

  it('marks streamed text done and stamps duration on the last assistant text', () => {
    ingest(content('done text'))
    ingest({ type: 'turn.completed', threadId: THREAD, durationMs: 950 } as RuntimeEvent)
    flushQueue()

    expect(items()[0]).toMatchObject({ kind: 'text', done: true, durationMs: 950 })
  })
})

describe('unread counting', () => {
  it('does not bump unread for the thread on screen', () => {
    ingest(content('hi'))
    flushQueue()
    expect(useChatStore.getState().threads[KEY].unread).toBe(0)
  })

  it('bumps once per assistant message for a background thread', () => {
    useChatStore.setState({ activeKey: 'other' })
    ingest(content('a', 'msg-1'))
    ingest(content('aa', 'msg-1')) // same message, still one unread
    ingest(content('b', 'msg-2'))
    flushQueue()

    expect(useChatStore.getState().threads[KEY].unread).toBe(2)
  })
})

/**
 * A user turn is appended optimistically by the sender AND broadcast back by
 * the backend. Both must land on one bubble.
 *
 * The old defence was a set of "origins I sent", consulted on arrival. It broke
 * whenever that set and the arriving event were not in the same place: a hot
 * reload, a remount, a second panel claiming the event, or a restart with the
 * message still queued. Deriving the id from the origin makes the collapse a
 * property of the data instead.
 */
describe('user.message echo', () => {
  const KEY = threadKey('c1', 't1')

  beforeEach(() => {
    resetQueue()
    useChatStore.setState({ threads: {}, activeKey: null })
  })

  it('collapses the echo onto the optimistic bubble', () => {
    const origin = 'm-123'
    useChatStore.getState().addUserMessage(KEY, 'hello', undefined, echoMessageId(origin))
    useChatStore.getState().ingestNow('c1', {
      type: 'user.message',
      threadId: 't1',
      text: 'hello',
      origin,
      at: Date.now(),
    })
    const users = useChatStore.getState().threads[KEY].items.filter((i) => i.kind === 'user')
    expect(users).toHaveLength(1)
  })

  it('is idempotent if the echo arrives twice', () => {
    const origin = 'm-456'
    const event = { type: 'user.message' as const, threadId: 't1', text: 'hi', origin, at: 1 }
    useChatStore.getState().ingestNow('c1', event)
    useChatStore.getState().ingestNow('c1', event)
    expect(useChatStore.getState().threads[KEY].items.filter((i) => i.kind === 'user')).toHaveLength(1)
  })

  it('still shows a turn sent from another device', () => {
    useChatStore.getState().ingestNow('c1', {
      type: 'user.message',
      threadId: 't1',
      text: 'from the phone',
      origin: 'someone-else',
      at: 1,
    })
    const users = useChatStore.getState().threads[KEY].items.filter((i) => i.kind === 'user')
    expect(users).toHaveLength(1)
    expect((users[0] as { text: string }).text).toBe('from the phone')
  })
})
