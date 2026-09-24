import { describe, expect, it } from 'vitest'
import {
  NO_QUEUED_TURNS,
  applyQueuedTurnEvent,
  queuedTurnComposerText,
  seedQueuedTurns,
} from '@shared/queued-turns'

const turn = { threadId: 't1', messageId: 'remote_a', text: 'later', queuedAt: 5 }

describe('queued turns on a client', () => {
  it('adds a queued message by its row id and removes it on any exit', () => {
    const queued = applyQueuedTurnEvent(NO_QUEUED_TURNS, { type: 'turn.queued', ...turn })
    expect(queued).toEqual({ remote_a: turn })
    for (const reason of ['started', 'promoted', 'cancelled', 'dropped'] as const) {
      expect(applyQueuedTurnEvent(queued, { type: 'turn.dequeued', threadId: 't1', messageId: 'remote_a', reason })).toEqual({})
    }
  })
  it('keeps the same object when nothing changed, so stores can skip a render', () => {
    const queued = seedQueuedTurns([turn])
    expect(applyQueuedTurnEvent(queued, { type: 'turn.dequeued', threadId: 't1', messageId: 'other', reason: 'started' })).toBe(queued)
    expect(applyQueuedTurnEvent(queued, { type: 'status', threadId: 't1', status: 'running' })).toBe(queued)
  })
  it('forgets everything when the session stops or dies', () => {
    const queued = seedQueuedTurns([turn])
    expect(applyQueuedTurnEvent(queued, { type: 'status', threadId: 't1', status: 'stopped' })).toBe(NO_QUEUED_TURNS)
    expect(applyQueuedTurnEvent(queued, { type: 'status', threadId: 't1', status: 'error' })).toBe(NO_QUEUED_TURNS)
  })
  it('seeds from the backend list, replacing what was there', () => {
    expect(seedQueuedTurns([])).toBe(NO_QUEUED_TURNS)
    expect(seedQueuedTurns([turn])).toEqual({ remote_a: turn })
  })
})

describe('text a cancelled message puts back', () => {
  it('is what the user typed', () => {
    expect(queuedTurnComposerText('typed', undefined, undefined)).toBe('typed')
    expect(queuedTurnComposerText('From "A": wrapped', 'wrapped', {})).toBe('wrapped')
  })
  it('is the expanded text when pills carried the content', () => {
    expect(queuedTurnComposerText('see `a.ts`\n```\ncode\n```', 'see [[pill:p1]]', { p1: { label: 'a.ts', kind: 'file' } }))
      .toBe('see `a.ts`\n```\ncode\n```')
  })
})
