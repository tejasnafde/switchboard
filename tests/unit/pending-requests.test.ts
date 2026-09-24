import { describe, expect, it } from 'vitest'
import { applyPendingRequestEvent, missingPendingRequests, pendingRequestKey, type PendingBlockingEvent } from '../../src/shared/pending-requests'

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

describe('applyPendingRequestEvent', () => {
  it('adds on open, replaces a re-sent card and removes it on its close', () => {
    const opened = applyPendingRequestEvent([], approval)
    expect(opened).toEqual([approval])
    expect(applyPendingRequestEvent(opened, approval)).toEqual([approval])
    expect(applyPendingRequestEvent([approval, question], { type: 'request.closed', threadId: 't1', requestId: 'r1', decision: 'approve' })).toEqual([question])
    expect(applyPendingRequestEvent([question], { type: 'question.answered', threadId: 't1', requestId: 'q1', answers: [] })).toEqual([])
  })

  it('keeps a plan through its turn ending and clears it on the next user message', () => {
    const current = [plan]
    expect(applyPendingRequestEvent(current, { type: 'turn.completed', threadId: 't1' } as never)).toBe(current)
    expect(applyPendingRequestEvent([approval, plan], { type: 'user.message', threadId: 't1', text: 'go', at: 1 })).toEqual([approval])
  })

  it('clears everything when the provider errors or stops, and returns the same array otherwise', () => {
    expect(applyPendingRequestEvent([approval, plan], { type: 'status', threadId: 't1', status: 'error' })).toEqual([])
    expect(applyPendingRequestEvent([approval, plan], { type: 'status', threadId: 't1', status: 'stopped' })).toEqual([])
    const current = [approval]
    expect(applyPendingRequestEvent(current, { type: 'status', threadId: 't1', status: 'running' })).toBe(current)
  })

  it('matches the registry on queued sends and peer messages: plans close on user.message only, approvals never', () => {
    const queued = applyPendingRequestEvent([approval, question, plan], { type: 'user.message', threadId: 't1', text: 'next', origin: 'o1', at: 2 })
    expect(queued).toEqual([approval, question])
    const current = [plan]
    expect(applyPendingRequestEvent(current, {
      type: 'peer.message', threadId: 't1', direction: 'received', initiator: 'agent',
      messageId: 'pm_1', peerThreadId: 't2', peerLabel: 'Sibling', text: 'hi', at: 3,
    })).toBe(current)
  })
})
