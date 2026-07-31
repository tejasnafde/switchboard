/**
 * First tests for the mobile chat store. Covers the two device-found bugs
 * (streamed text duplicating, tool spinners never settling) and the event
 * coalescing that keeps a phone from rendering once per token.
 */
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
