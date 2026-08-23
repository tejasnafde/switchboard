import { describe, expect, it } from 'vitest'
import type { RuntimeEvent } from '../../src/shared/provider-events'
import { createContentCoalescer } from '../../src/renderer/services/contentCoalescer'
import {
  createMessageLifecycleTracker,
  finishRuntimeEventLifecycle,
  prepareRuntimeEventLifecycle,
} from '../../src/renderer/services/messageLifecycle'

function content(messageId: string, text: string, append?: boolean): RuntimeEvent {
  return {
    type: 'content',
    threadId: 'thread-1',
    messageId,
    text,
    append,
    streamKind: 'assistant',
  }
}

function completed(): RuntimeEvent {
  return { type: 'turn.completed', threadId: 'thread-1' }
}

describe('message-level Markdown copy lifecycle', () => {
  it('defaults historical and remounted settled messages to settled', () => {
    const tracker = createMessageLifecycleTracker()

    expect(tracker.isMutable('thread-1', 'historical')).toBe(false)
    tracker.markMutable('thread-1', 'live')
    expect(tracker.isMutable('thread-1', 'live')).toBe(true)
    tracker.settleThread('thread-1')
    expect(tracker.isMutable('thread-1', 'live')).toBe(false)
  })

  it('tracks cumulative snapshots and appended deltas by thread/message identity', () => {
    const tracker = createMessageLifecycleTracker()
    const flushes: string[] = []

    prepareRuntimeEventLifecycle(content('answer', 'sel'), tracker, (threadId) => flushes.push(threadId))
    prepareRuntimeEventLifecycle(content('answer', 'select 1'), tracker, (threadId) => flushes.push(threadId))
    prepareRuntimeEventLifecycle(content('reasoning', 'because', true), tracker, (threadId) => flushes.push(threadId))

    expect(tracker.isMutable('thread-1', 'answer')).toBe(true)
    expect(tracker.isMutable('thread-1', 'reasoning')).toBe(true)
    expect(flushes).toEqual([])
  })

  it('flushes pending coalesced content before turn completion settles touched messages', () => {
    const tracker = createMessageLifecycleTracker()
    const order: string[] = []
    tracker.subscribe(() => {
      if (!tracker.isMutable('thread-1', 'answer')) order.push('settled')
    })
    const coalescer = createContentCoalescer((pending) => order.push(`commit:${pending.text}`), 60_000)

    const first = content('answer', 'select')
    prepareRuntimeEventLifecycle(first, tracker, (threadId) => coalescer.flushThread(threadId))
    coalescer.push(first.threadId, first.messageId, { text: first.text, append: first.append })
    const done = completed()
    prepareRuntimeEventLifecycle(done, tracker, (threadId) => coalescer.flushThread(threadId))
    finishRuntimeEventLifecycle(done, tracker)

    expect(order).toEqual(['commit:select', 'settled'])
    expect(tracker.isMutable('thread-1', 'answer')).toBe(false)
    coalescer.dispose()
  })

  it('does not remutate a completed old message for unrelated tool or running-status events', () => {
    const tracker = createMessageLifecycleTracker()
    tracker.markMutable('thread-1', 'old-answer')
    finishRuntimeEventLifecycle(completed(), tracker)

    const events: RuntimeEvent[] = [
      { type: 'tool.started', threadId: 'thread-1', toolId: 'tool-1', toolName: 'Read', input: {} },
      { type: 'status', threadId: 'thread-1', status: 'running' },
    ]
    for (const event of events) {
      prepareRuntimeEventLifecycle(event, tracker, () => {})
      finishRuntimeEventLifecycle(event, tracker)
    }

    expect(tracker.isMutable('thread-1', 'old-answer')).toBe(false)
  })

  it('settles touched messages on errors, interruption-like idle, and provider shutdown', () => {
    const terminalEvents: RuntimeEvent[] = [
      { type: 'error', threadId: 'thread-1', message: 'provider failed' },
      { type: 'status', threadId: 'thread-1', status: 'idle' },
      { type: 'status', threadId: 'thread-1', status: 'stopped' },
    ]

    for (const event of terminalEvents) {
      const tracker = createMessageLifecycleTracker()
      tracker.markMutable('thread-1', 'answer')
      finishRuntimeEventLifecycle(event, tracker)
      expect(tracker.isMutable('thread-1', 'answer')).toBe(false)
    }
  })
})
