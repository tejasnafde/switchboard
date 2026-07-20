/** Exponential reconnect backoff with a cap. */
import { describe, it, expect } from 'vitest'
import { reconnectDelay } from '../../src/main/machines/reconnectBackoff'

describe('reconnectDelay', () => {
  it('doubles per attempt from the base', () => {
    expect(reconnectDelay(1, { baseMs: 1000, capMs: 30_000 })).toBe(1000)
    expect(reconnectDelay(2, { baseMs: 1000, capMs: 30_000 })).toBe(2000)
    expect(reconnectDelay(3, { baseMs: 1000, capMs: 30_000 })).toBe(4000)
  })

  it('caps the delay', () => {
    expect(reconnectDelay(10, { baseMs: 1000, capMs: 30_000 })).toBe(30_000)
  })

  it('treats attempt < 1 as the base delay', () => {
    expect(reconnectDelay(0, { baseMs: 1000, capMs: 30_000 })).toBe(1000)
  })

  it('spreads with jitter but never exceeds the cap', () => {
    expect(reconnectDelay(10, { baseMs: 1000, capMs: 30_000, jitter: 0.25, rng: () => 1 })).toBe(30_000)
    expect(reconnectDelay(10, { baseMs: 1000, capMs: 30_000, jitter: 0.25, rng: () => 0 })).toBe(22_500)
    expect(reconnectDelay(1, { baseMs: 1000, capMs: 30_000, jitter: 0.25, rng: () => 0.5 })).toBe(1000)
  })
})
