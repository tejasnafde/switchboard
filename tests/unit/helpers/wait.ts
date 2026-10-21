import { vi } from 'vitest'

/**
 * Retries `check` until it stops throwing. Polls every millisecond, so a test
 * waits only as long as the work takes, and gives up after 5 s, which leaves
 * room for a slow CI machine.
 */
export function until<T>(check: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(check, { interval: 1, timeout: 5000 })
}

/** One event-loop turn: lets queued fire-and-forget work finish before a check that nothing more happened. */
export function drain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
