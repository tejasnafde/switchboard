import { describe, expect, it } from 'vitest'
import { QueuedTurnLedger } from '../../src/main/provider/queued-turn-ledger'

describe('QueuedTurnLedger: a held queue and a message that could not start', () => {
  it('lists the queue as held until resumed, and stamps a message that joins it', () => {
    const ledger = new QueuedTurnLedger()
    ledger.observe({ type: 'turn.queued', threadId: 't', messageId: 'a', text: 'A', queuedAt: 1 }, 'codex')
    ledger.observe({ type: 'turn.queue-held', threadId: 't', held: true, reason: 'limit' }, 'codex')
    expect(ledger.list('t')).toEqual([{ threadId: 't', messageId: 'a', text: 'A', queuedAt: 1, held: true }])
    const joined = ledger.observe(
      { type: 'turn.queued', threadId: 't', messageId: 'b', text: 'B', queuedAt: 2 },
      'codex',
    )
    expect(joined.event).toMatchObject({ messageId: 'b', held: true })
    ledger.observe({ type: 'turn.queue-held', threadId: 't', held: false }, 'codex')
    expect(ledger.list('t').some((turn) => turn.held)).toBe(false)
  })

  it('keeps a message that failed to start, with its text, until the user cancels it', () => {
    const ledger = new QueuedTurnLedger()
    ledger.observe({ type: 'turn.queued', threadId: 't', messageId: 'a', text: 'A', queuedAt: 1 }, 'codex')
    ledger.observe({ type: 'turn.dequeued', threadId: 't', messageId: 'a', reason: 'started' }, 'codex')
    expect(ledger.list('t')).toEqual([])
    const failed = ledger.observe(
      { type: 'turn.dequeued', threadId: 't', messageId: 'a', reason: 'failed', error: 'boom' },
      'codex',
    )
    expect(failed.releasesOutstandingTurn).toBe(false)
    expect(ledger.list('t')).toEqual([{ threadId: 't', messageId: 'a', text: 'A', queuedAt: 1, failed: 'boom' }])
    expect(ledger.removeFailed('t', 'a')?.text).toBe('A')
    expect(ledger.list('t')).toEqual([])
  })
})
