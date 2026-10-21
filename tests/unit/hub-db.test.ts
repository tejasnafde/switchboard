import { createMigratedDb } from './helpers/test-db'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  armLimitResume,
  createHubBatch,
  disarmLimitResume,
  ensureHubParent,
  findProposedHubBatch,
  getHubBatch,
  getHubChild,
  getHubParent,
  getLimitResume,
  insertHubChild,
  insertHubWake,
  listArmedLimitResumes,
  listHubChildren,
  listPendingHubWakes,
  markHubWakesDelivered,
  markLimitResumeFired,
  openChildParentId,
  recordThreadSession,
  setHubBatchStatus,
  setHubParentHeld,
  setLimitResumeStreak,
  updateHubChild,
} from '../../src/main/db/database'

const child = (childId: string, ordinal: number) => ({
  childId,
  parentId: 'agent_parent',
  batchId: 'b1',
  ordinal,
  title: `Child ${ordinal}`,
  brief: 'Do it',
  location: 'worktree' as const,
  grantedMode: 'sandbox' as const,
  depsMode: 'link' as const,
})

beforeEach(() => {
  createMigratedDb()
})

describe('hub tables', () => {
  it('creates a parent once and sets and lifts the hold', () => {
    ensureHubParent('agent_parent')
    ensureHubParent('agent_parent')
    expect(getHubParent('agent_parent')).toEqual({
      parentId: 'agent_parent',
      held: false,
      heldReason: null,
      heldAt: null,
    })
    setHubParentHeld('agent_parent', true, 'stop')
    expect(getHubParent('agent_parent')).toMatchObject({ held: true, heldReason: 'stop' })
    setHubParentHeld('agent_parent', false)
    expect(getHubParent('agent_parent')).toEqual({
      parentId: 'agent_parent',
      held: false,
      heldReason: null,
      heldAt: null,
    })
  })

  it('finds a proposed batch by its plan digest until it is decided', () => {
    createHubBatch({ batchId: 'b1', parentId: 'agent_parent', cardRequestId: 'req1', planJson: '[]', planDigest: 'd1' })
    expect(findProposedHubBatch('agent_parent', 'd1')?.batchId).toBe('b1')
    setHubBatchStatus('b1', 'approved')
    expect(getHubBatch('b1')?.status).toBe('approved')
    expect(findProposedHubBatch('agent_parent', 'd1')).toBeNull()
  })

  it('stores children, looks up an open child by its id, and refuses a repeated ordinal', () => {
    insertHubChild(child('agent_c1', 0))
    insertHubChild(child('agent_c2', 1))
    expect(() => insertHubChild(child('agent_c3', 1))).toThrow(/UNIQUE/)
    expect(getHubChild('agent_c1')).toMatchObject({ phase: 'starting', creationId: 'b1-0', branch: null })
    expect(openChildParentId('agent_c1')).toBe('agent_parent')

    updateHubChild('agent_c1', { phase: 'settled', settledAt: 5 })
    expect(openChildParentId('agent_c1')).toBeNull()
    expect(listHubChildren('agent_parent').map((c) => c.childId)).toEqual(['agent_c2'])
    expect(listHubChildren('agent_parent', { includeSettled: true })).toHaveLength(2)
    expect(openChildParentId('agent_unknown')).toBeNull()
  })

  it('keeps wakes pending until a revision delivers them, once', () => {
    const pointer = { childId: 'agent_c1', toolCallId: 'tc1', at: 1 }
    insertHubWake({ id: 'w1', parentId: 'agent_parent', childId: 'agent_c1', kind: 'report', summary: 'Done', pointer })
    insertHubWake({
      id: 'w2',
      parentId: 'agent_parent',
      childId: 'agent_c2',
      kind: 'stopped',
      summary: 'Stopped',
      pointer: null,
    })
    const pending = listPendingHubWakes('agent_parent')
    expect(pending.map((w) => w.id)).toEqual(['w1', 'w2'])
    expect(pending[0].pointer).toMatchObject(pointer)
    expect(markHubWakesDelivered(['w1'], 7)).toBe(1)
    expect(markHubWakesDelivered(['w1', 'w2'], 8)).toBe(1)
    expect(listPendingHubWakes('agent_parent')).toEqual([])
  })

  it('resolves a rotated Claude id to the root conversation', () => {
    recordThreadSession('uuid-parent', 'agent_parent')
    recordThreadSession('uuid-child', 'agent_c1')
    insertHubChild({ ...child('uuid-child', 0), parentId: 'uuid-parent' })
    expect(getHubChild('agent_c1')?.parentId).toBe('agent_parent')
    expect(openChildParentId('uuid-child')).toBe('agent_parent')
    expect(listHubChildren('uuid-parent')).toHaveLength(1)
    setHubParentHeld('uuid-parent', true)
    expect(getHubParent('agent_parent')?.held).toBe(true)
  })
})

describe('limit_resumes', () => {
  const arm = (requestId: string, conversationId = 'agent_a') =>
    armLimitResume({ conversationId, providerInstanceId: 'i1', limitedTurnId: 't1', resetAt: 100, requestId })

  it('arms, fires once per arm, and keeps the streak across arms', () => {
    arm('r1')
    expect(getLimitResume('agent_a')).toMatchObject({ state: 'armed', requestId: 'r1', streak: 0 })
    expect(markLimitResumeFired('agent_a', 'r0', 5)).toBe(false)
    expect(markLimitResumeFired('agent_a', 'r1', 5)).toBe(true)
    expect(markLimitResumeFired('agent_a', 'r1', 6)).toBe(false)
    setLimitResumeStreak('agent_a', 1, false)
    arm('r2')
    expect(getLimitResume('agent_a')).toMatchObject({ state: 'armed', requestId: 'r2', streak: 1, lastFiredAt: 5 })
    setLimitResumeStreak('agent_a', 3, true)
    expect(getLimitResume('agent_a')?.state).toBe('gave_up')
    setLimitResumeStreak('agent_a', 0, false)
    expect(getLimitResume('agent_a')).toMatchObject({ state: 'fired', streak: 0 })
  })

  it('disarms only an armed row, durably, and lists armed rows by reset', () => {
    arm('r1')
    armLimitResume({
      conversationId: 'agent_b',
      providerInstanceId: 'i1',
      limitedTurnId: 't9',
      resetAt: 50,
      requestId: 'r9',
    })
    expect(listArmedLimitResumes().map((r) => r.conversationId)).toEqual(['agent_b', 'agent_a'])
    expect(disarmLimitResume('agent_a', 'stop')).toBe(true)
    expect(disarmLimitResume('agent_a', 'cancel')).toBe(false)
    expect(getLimitResume('agent_a')).toMatchObject({ state: 'disarmed', disarmReason: 'stop' })
    expect(markLimitResumeFired('agent_a', 'r1', 5)).toBe(false)
    expect(listArmedLimitResumes().map((r) => r.conversationId)).toEqual(['agent_b'])
  })

  it('keys a rotated Claude id by its root', () => {
    recordThreadSession('uuid-a', 'agent_a')
    arm('r1', 'uuid-a')
    expect(getLimitResume('agent_a')?.requestId).toBe('r1')
    expect(disarmLimitResume('uuid-a', 'archive')).toBe(true)
  })
})
