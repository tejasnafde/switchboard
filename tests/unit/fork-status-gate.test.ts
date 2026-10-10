import { describe, expect, it } from 'vitest'
import { forkBlockedByStatus } from '../../src/shared/conversation-fork'

describe('forkBlockedByStatus', () => {
  it('blocks only a turn in flight', () => {
    expect(forkBlockedByStatus('running')).toBe(true)
    expect(forkBlockedByStatus('thinking')).toBe(true)
    expect(forkBlockedByStatus('idle')).toBe(false)
    // A failed last turn or an exited session leaves a settled history.
    expect(forkBlockedByStatus('error')).toBe(false)
    expect(forkBlockedByStatus('exited')).toBe(false)
  })
})
