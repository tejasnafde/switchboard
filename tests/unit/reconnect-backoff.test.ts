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
})
