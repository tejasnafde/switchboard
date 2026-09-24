import { describe, expect, it } from 'vitest'
import {
  missingPendingCards,
  pendingRequestMessageId,
  pendingRequestToChatMessage,
} from '../../src/renderer/services/pending-request-recovery'
import type { PendingBlockingEvent } from '../../src/shared/pending-requests'

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
  questions: [{ id: 'q1', header: 'H', question: 'Pick', options: [{ label: 'a' }], multiSelect: false }],
}

const plan: PendingBlockingEvent = { type: 'plan.proposed', threadId: 't1', planId: 'p1', planMarkdown: '# Plan' }

describe('pendingRequestMessageId', () => {
  it('matches the ids ChatPanel builds for a live event', () => {
    expect(pendingRequestMessageId(approval)).toBe('approval_r1')
    expect(pendingRequestMessageId(question)).toBe('question_q1')
    expect(pendingRequestMessageId(plan)).toBe('plan_p1')
  })
})

describe('missingPendingCards', () => {
  it('drops events whose message id is already shown', () => {
    const shown = new Set(['approval_r1', 'some_other_message'])
    expect(missingPendingCards([approval, question, plan], shown)).toEqual([question, plan])
  })

  it('returns everything when nothing overlaps', () => {
    expect(missingPendingCards([approval, question, plan], new Set())).toEqual([approval, question, plan])
  })
})

describe('pendingRequestToChatMessage', () => {
  it('builds an approval card', () => {
    expect(pendingRequestToChatMessage(approval, 123)).toEqual({
      id: 'approval_r1',
      role: 'assistant',
      content: '',
      timestamp: 123,
      approval: { toolName: 'Bash', detail: 'ls', status: 'pending' },
    })
  })

  it('builds a question card', () => {
    expect(pendingRequestToChatMessage(question, 123)).toEqual({
      id: 'question_q1',
      role: 'assistant',
      content: '',
      timestamp: 123,
      question: { requestId: 'q1', questions: question.questions, status: 'pending' },
    })
  })

  it('builds a plan card', () => {
    expect(pendingRequestToChatMessage(plan, 123)).toEqual({
      id: 'plan_p1',
      role: 'assistant',
      content: '',
      timestamp: 123,
      plan: { id: 'p1', markdown: '# Plan' },
    })
  })
})
