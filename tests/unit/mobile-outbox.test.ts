/**
 * The send queue's decisions.
 *
 * These matter because the outbox is the ONLY send path, not a fallback. Every
 * message the user commits to passes through them, so a wrong answer here is
 * either a lost message or a duplicated one, and both are worse than any
 * failure the queue exists to absorb.
 */
import { describe, it, expect } from 'vitest'
import {
  deliveryAction,
  retryDelayMs,
  shouldRetry,
  MAX_RETRY_DELAY_MS,
} from '../../apps/mobile/src/lib/outboxModel'
import { TurnDeduper } from '../../src/shared/turn-dedupe'

const base = {
  connected: true,
  threadBusy: false,
  threadExists: true,
  editing: false,
  nowMs: 1_000,
  retryNotBeforeMs: 0,
}

describe('deliveryAction', () => {
  it('sends when the backend is up and the thread is free', () => {
    expect(deliveryAction(base)).toBe('send')
  })

  it('waits while offline rather than failing the message', () => {
    expect(deliveryAction({ ...base, connected: false })).toBe('wait')
  })

  it('waits while the provider cannot take a mid-turn message', () => {
    expect(deliveryAction({ ...base, threadBusy: true })).toBe('wait')
  })

  it('waits while the user has the message open for editing', () => {
    // Delivering here would send a payload the user is still changing.
    expect(deliveryAction({ ...base, editing: true })).toBe('wait')
  })

  it('waits until the backoff has elapsed', () => {
    expect(deliveryAction({ ...base, nowMs: 1_000, retryNotBeforeMs: 5_000 })).toBe('wait')
    expect(deliveryAction({ ...base, nowMs: 5_000, retryNotBeforeMs: 5_000 })).toBe('send')
  })

  it('drops a message whose thread is gone, which no retry can fix', () => {
    expect(deliveryAction({ ...base, threadExists: false })).toBe('drop')
  })

  it('prefers dropping over sending when the thread is gone, whatever else is true', () => {
    expect(deliveryAction({ ...base, threadExists: false, connected: false, editing: true })).toBe('drop')
  })
})

describe('retryDelayMs', () => {
  it('backs off from one second and caps', () => {
    expect(retryDelayMs(1)).toBe(1_000)
    expect(retryDelayMs(2)).toBe(2_000)
    expect(retryDelayMs(3)).toBe(4_000)
    expect(retryDelayMs(99)).toBe(MAX_RETRY_DELAY_MS)
  })

  it('never returns a negative or zero delay for a first attempt', () => {
    expect(retryDelayMs(0)).toBeGreaterThan(0)
  })
})

describe('shouldRetry', () => {
  it('retries a transport failure, which says nothing about the message', () => {
    expect(shouldRetry(new Error('WebSocket closed'))).toBe(true)
    expect(shouldRetry(new Error('invoke timed out: provider:send-turn'))).toBe(true)
    expect(shouldRetry(new Error('transport queue full: provider:send-turn'))).toBe(true)
  })

  it('gives up when the backend understood and refused', () => {
    // Repeating a refusal burns the battery against a wall and hides the
    // reason from the user. Retrying everything forever is the more common
    // mistake and the harder one to notice.
    expect(shouldRetry(new Error('No session: thread-1'))).toBe(false)
    expect(shouldRetry(new Error('no handler: provider:send-turn'))).toBe(false)
  })
})

describe('TurnDeduper', () => {
  it('accepts an origin once and refuses it after', () => {
    const d = new TurnDeduper()
    expect(d.isDuplicate('turn-1')).toBe(false)
    expect(d.isDuplicate('turn-1')).toBe(true)
  })

  it('treats a missing origin as always new', () => {
    // Older clients send none. Collapsing them all onto one key would drop
    // every message after the first.
    const d = new TurnDeduper()
    expect(d.isDuplicate(undefined)).toBe(false)
    expect(d.isDuplicate(undefined)).toBe(false)
  })

  it('forgets an origin older than the window', () => {
    const d = new TurnDeduper(1_000)
    expect(d.isDuplicate('turn-1', 0)).toBe(false)
    expect(d.isDuplicate('turn-1', 500)).toBe(true)
    // Past the window nothing can still be in flight, so holding it is a leak.
    expect(d.isDuplicate('turn-1', 2_000)).toBe(false)
  })

  it('stays bounded on a long-running backend', () => {
    const d = new TurnDeduper(60_000, 10)
    for (let i = 0; i < 100; i++) d.isDuplicate(`turn-${i}`, 1)
    expect(d.size).toBeLessThanOrEqual(10)
  })

  it('keeps the most recent origins when it evicts', () => {
    const d = new TurnDeduper(60_000, 2)
    d.isDuplicate('a', 1)
    d.isDuplicate('b', 2)
    d.isDuplicate('c', 3)
    // 'a' fell out, so a late retry of it would run again. That is the cost of
    // the bound, and why the bound is far larger than any real retry window.
    expect(d.isDuplicate('c', 4)).toBe(true)
    expect(d.isDuplicate('b', 4)).toBe(true)
  })
})
