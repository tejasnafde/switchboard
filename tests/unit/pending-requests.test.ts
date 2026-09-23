import { describe, expect, it } from 'vitest'
import { missingPendingRequests, pendingRequestKey, type PendingBlockingEvent } from '../../src/shared/pending-requests'

const approval: PendingBlockingEvent = {
  type: 'request.opened',
  threadId: 't1',
  requestId: 'r1',
  requestType: 'command',
  toolName: 'Bash',
  detail: 'ls',
}

const question: PendingBlockingEvent = {
  type: 'question.asked',
  threadId: 't1',
  requestId: 'q1',
  questions: [],
}

const plan: PendingBlockingEvent = {
  type: 'plan.proposed',
  threadId: 't1',
  planId: 'p1',
  planMarkdown: '# Plan',
}

describe('pendingRequestKey', () => {
  it('keys an approval and a question by requestId', () => {
    expect(pendingRequestKey(approval)).toBe('r1')
    expect(pendingRequestKey(question)).toBe('q1')
  })

  it('keys a plan by planId', () => {
    expect(pendingRequestKey(plan)).toBe('p1')
  })
})

describe('missingPendingRequests', () => {
  it('returns everything when nothing is shown', () => {
    expect(missingPendingRequests([approval, question, plan], new Set())).toEqual([approval, question, plan])
  })

  it('drops events whose key is already shown', () => {
    expect(missingPendingRequests([approval, question, plan], new Set(['r1', 'p1']))).toEqual([question])
  })

  it('returns nothing when everything is already shown', () => {
    expect(missingPendingRequests([approval, question, plan], new Set(['r1', 'q1', 'p1']))).toEqual([])
  })
})
