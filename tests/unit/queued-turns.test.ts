import { describe, expect, it } from 'vitest'
import {
  NO_QUEUED_TURNS,
  applyQueuedTurnEvent,
  queueIsHeld,
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
  it('forgets everything when the session stops, but keeps the rows after a failed turn', () => {
    const queued = seedQueuedTurns([turn])
    expect(applyQueuedTurnEvent(queued, { type: 'status', threadId: 't1', status: 'stopped' })).toBe(NO_QUEUED_TURNS)
    // The backend holds them after a failed or usage-limited turn.
    expect(applyQueuedTurnEvent(queued, { type: 'status', threadId: 't1', status: 'error' })).toBe(queued)
  })
  it('marks the queue held and resumed, and a message that could not start as failed', () => {
    let state = seedQueuedTurns([turn, { ...turn, messageId: 'remote_b' }])
    state = applyQueuedTurnEvent(state, { type: 'turn.queue-held', threadId: 't1', held: true, reason: 'usage limit' })
    expect(queueIsHeld(state)).toBe(true)
    expect(state.remote_a.held).toBe(true)
    // Joins a held queue.
    state = applyQueuedTurnEvent(state, { type: 'turn.queued', ...turn, messageId: 'remote_c', held: true })
    expect(state.remote_c.held).toBe(true)
    state = applyQueuedTurnEvent(state, { type: 'turn.queue-held', threadId: 't1', held: false })
    expect(queueIsHeld(state)).toBe(false)
    expect('held' in state.remote_a).toBe(false)

    state = applyQueuedTurnEvent(state, { type: 'turn.dequeued', threadId: 't1', messageId: 'remote_a', reason: 'started' })
    expect(state.remote_a).toBeUndefined()
    state = applyQueuedTurnEvent(state, { type: 'turn.dequeued', threadId: 't1', messageId: 'remote_a', reason: 'failed', error: 'rate limited' })
    expect(state.remote_a).toMatchObject({ messageId: 'remote_a', failed: 'rate limited' })
    // A failed row never shows as held: it has left the queue.
    state = applyQueuedTurnEvent(state, { type: 'turn.queue-held', threadId: 't1', held: true })
    expect(state.remote_a.held).toBeUndefined()
    expect(state.remote_b.held).toBe(true)
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
