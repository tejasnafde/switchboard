import { describe, expect, it } from 'vitest'
import { missingPendingFeedItems, shownPendingKeys } from '../../apps/mobile/src/lib/pending-request-recovery'
import type { FeedItem } from '../../apps/mobile/src/stores/chat'
import type { PendingBlockingEvent } from '../../src/shared/pending-requests'

const approval: PendingBlockingEvent = {
  type: 'request.opened',
  threadId: 't1',
  requestId: 'r1',
  requestType: 'command',
  toolName: 'Bash',
  detail: 'ls',
}

const question: PendingBlockingEvent = { type: 'question.asked', threadId: 't1', requestId: 'q1', questions: [] }
const plan: PendingBlockingEvent = { type: 'plan.proposed', threadId: 't1', planId: 'p1', planMarkdown: '# Plan' }

describe('shownPendingKeys', () => {
  it('collects requestId from approval/question items and planId from a plan item', () => {
    const items: FeedItem[] = [
      { kind: 'approval', id: 'a-r1', requestId: 'r1', toolName: 'Bash', detail: 'ls', requestType: 'command', state: 'pending' },
      { kind: 'question', id: 'q-q1', requestId: 'q1', questions: [] },
      { kind: 'plan', id: 'p-p1', planId: 'p1', markdown: '# Plan' },
      { kind: 'text', id: 't-1', text: 'hi', stream: 'assistant', done: true },
    ]
    expect(shownPendingKeys(items)).toEqual(new Set(['r1', 'q1', 'p1']))
  })

  it('is empty for a feed with no blocking cards', () => {
    const items: FeedItem[] = [{ kind: 'text', id: 't-1', text: 'hi', stream: 'assistant', done: true }]
    expect(shownPendingKeys(items)).toEqual(new Set())
  })
})

describe('missingPendingFeedItems', () => {
  it('drops pending events already represented in the feed', () => {
    const items: FeedItem[] = [
      { kind: 'approval', id: 'a-r1', requestId: 'r1', toolName: 'Bash', detail: 'ls', requestType: 'command', state: 'pending' },
    ]
    expect(missingPendingFeedItems([approval, question, plan], items)).toEqual([question, plan])
  })

  it('returns everything for an empty feed', () => {
    expect(missingPendingFeedItems([approval, question, plan], [])).toEqual([approval, question, plan])
  })
})
