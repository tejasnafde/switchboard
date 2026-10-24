/**
 * Needs you, Working and Done recently on the phone's chat list: the grouping
 * rule, the open cards the chat store tracks from live events, and the seed
 * from provider:get-pending-requests when the list loads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chatActivity, chatGroupKey, groupChats, type ChatGroupKey } from '../../apps/mobile/src/lib/chat-activity'
import { useChatStore, resetQueue, threadKey } from '../../apps/mobile/src/stores/chat'
import { PENDING_SEED_ROWS, seedListPendingRequests } from '../../apps/mobile/src/stores/list-pending'
import type { PendingBlockingEvent } from '../../src/shared/pending-requests'
import type { RuntimeEvent } from '../../src/shared/provider-events'

const CONN = 'conn'
const THREAD = 't1'
const KEY = threadKey(CONN, THREAD)

const approval = (requestId: string, threadId = THREAD) =>
  ({ type: 'request.opened', threadId, requestId, toolName: 'Bash', detail: 'ls' }) as PendingBlockingEvent
const question = (requestId: string) =>
  ({ type: 'question.asked', threadId: THREAD, requestId, questions: [] }) as PendingBlockingEvent
const plan = (planId: string) =>
  ({ type: 'plan.proposed', threadId: THREAD, planId, planMarkdown: '# Plan' }) as PendingBlockingEvent

function ingest(event: RuntimeEvent | PendingBlockingEvent): void {
  useChatStore.getState().ingestNow(CONN, event as RuntimeEvent)
}

const pending = () => useChatStore.getState().threads[KEY]?.pendingRequests ?? []

beforeEach(() => {
  resetQueue()
  useChatStore.setState({ threads: {}, activeKey: null })
})

describe('chatActivity', () => {
  it('ranks an approval over a question over a plan over an error', () => {
    expect(chatActivity({ status: 'error', pendingRequests: [plan('p'), question('q'), approval('a')] })).toBe(
      'approval',
    )
    expect(chatActivity({ status: 'error', pendingRequests: [plan('p'), question('q')] })).toBe('input')
    expect(chatActivity({ status: 'error', pendingRequests: [plan('p')] })).toBe('plan')
    expect(chatActivity({ status: 'error' })).toBe('failed')
  })

  it('reads a running chat as working and anything else as nothing', () => {
    expect(chatActivity({ status: 'running' })).toBe('working')
    expect(chatActivity({ status: 'connecting' })).toBeNull()
    expect(chatActivity({ status: 'idle' })).toBeNull()
    expect(chatActivity(undefined)).toBeNull()
  })

  it('maps every card and an error to Needs you', () => {
    expect(['approval', 'input', 'plan', 'failed'].map((a) => chatGroupKey(a as never))).toEqual([
      'needs-you',
      'needs-you',
      'needs-you',
      'needs-you',
    ])
    expect(chatGroupKey('working')).toBe('working')
    expect(chatGroupKey(null)).toBe('done')
  })
})

describe('groupChats', () => {
  const rows = ['a', 'b', 'c', 'd', 'e']
  const by = (keys: Record<string, ChatGroupKey>) => (row: string) => keys[row] ?? 'done'

  it('orders Needs you, Working, Done recently and keeps the order inside each', () => {
    const groups = groupChats(rows, by({ b: 'working', d: 'needs-you', e: 'needs-you' }))
    expect(groups.map((g) => [g.label, g.items])).toEqual([
      ['Needs you', ['d', 'e']],
      ['Working', ['b']],
      ['Done recently', ['a', 'c']],
    ])
  })

  it('drops empty groups', () => {
    expect(groupChats(rows, by({ a: 'working' })).map((g) => g.key)).toEqual(['working', 'done'])
    expect(groupChats(['a'], by({ a: 'needs-you' })).map((g) => g.key)).toEqual(['needs-you'])
  })

  it('stays one plain list when nothing needs you or works', () => {
    expect(groupChats(rows, by({}))).toEqual([])
    expect(groupChats([], by({}))).toEqual([])
  })
})

describe('open cards from live events', () => {
  it('adds on open and removes on the matching close', () => {
    ingest(approval('r1'))
    ingest(question('q1'))
    expect(pending().map((e) => e.type)).toEqual(['request.opened', 'question.asked'])
    ingest({ type: 'request.closed', threadId: THREAD, requestId: 'r1' } as RuntimeEvent)
    ingest({ type: 'question.answered', threadId: THREAD, requestId: 'q1', answers: [] } as unknown as RuntimeEvent)
    expect(pending()).toEqual([])
  })

  it('clears everything on error or stop', () => {
    for (const status of ['error', 'stopped'] as const) {
      ingest(approval('r1'))
      ingest(plan('p1'))
      ingest({ type: 'status', threadId: THREAD, status } as RuntimeEvent)
      expect(pending()).toEqual([])
    }
  })

  it('clears a plan, not an approval, on the next user message', () => {
    ingest(approval('r1'))
    ingest(plan('p1'))
    ingest({ type: 'user.message', threadId: THREAD, messageId: 'u1', text: 'go' } as RuntimeEvent)
    expect(pending().map((e) => e.type)).toEqual(['request.opened'])
  })

  it('is not written to the disk cache', () => {
    ingest(approval('r1'))
    const persisted = useChatStore.persist.getOptions().partialize?.(useChatStore.getState()) as {
      threads: Record<string, object>
    }
    expect(persisted.threads[KEY]).not.toHaveProperty('pendingRequests')
    expect(persisted.threads[KEY]).not.toHaveProperty('pendingRevision')
  })
})

describe('seeding from provider:get-pending-requests', () => {
  function client(reply: (threadId: string) => Promise<PendingBlockingEvent[]>, capable = true) {
    return {
      supportsCapability: (c: string) => (c === 'pending_requests_v1' ? capable : undefined),
      getPendingRequests: vi.fn(reply),
    }
  }

  it('records a card that opened before the phone was listening', async () => {
    await seedListPendingRequests(
      CONN,
      client(async () => [approval('r1')]),
      [THREAD],
    )
    expect(chatActivity(useChatStore.getState().threads[KEY])).toBe('approval')
  })

  it('asks about the newest 15 chats only', async () => {
    const c = client(async () => [])
    await seedListPendingRequests(
      CONN,
      c,
      Array.from({ length: 20 }, (_, i) => `t${i}`),
    )
    expect(c.getPendingRequests).toHaveBeenCalledTimes(PENDING_SEED_ROWS)
    expect(c.getPendingRequests.mock.calls.map(([id]) => id)).toEqual(Array.from({ length: 15 }, (_, i) => `t${i}`))
  })

  it('does not ask an older backend', async () => {
    const c = client(async () => [], false)
    await seedListPendingRequests(CONN, c, [THREAD])
    expect(c.getPendingRequests).not.toHaveBeenCalled()
  })

  it('adds no entry for a chat with nothing open', async () => {
    await seedListPendingRequests(
      CONN,
      client(async () => []),
      [THREAD],
    )
    expect(useChatStore.getState().threads[KEY]).toBeUndefined()
  })

  it('does not reopen a card closed live while the backend answered', async () => {
    ingest(approval('r1'))
    let calls = 0
    const c = client(async () => {
      calls++
      if (calls === 1) {
        // The stale reply still holds r1; the close lands before it does.
        ingest({ type: 'request.closed', threadId: THREAD, requestId: 'r1' } as RuntimeEvent)
        return [approval('r1')]
      }
      return []
    })
    await seedListPendingRequests(CONN, c, [THREAD])
    expect(c.getPendingRequests).toHaveBeenCalledTimes(2)
    expect(pending()).toEqual([])
  })

  it('replaces a card the backend no longer holds', async () => {
    ingest(approval('r1'))
    await seedListPendingRequests(
      CONN,
      client(async () => []),
      [THREAD],
    )
    expect(pending()).toEqual([])
  })
})
