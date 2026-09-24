import { describe, expect, it } from 'vitest'
import { heldTurnActions, heldTurnFor, queueToggle } from '../../apps/mobile/src/lib/held-turns'

describe('phone steer/queue toggle', () => {
  it('reads as it always did with the Steer default', () => {
    expect(queueToggle('steer', false)).toMatchObject({ queues: false, label: 'Steering the running turn · tap to queue' })
    expect(queueToggle('steer', true)).toMatchObject({ queues: true, label: 'Sends after this turn' })
  })
  it('starts queued with the Queue default, and a tap steers once', () => {
    expect(queueToggle('queue', false)).toMatchObject({ queues: true, label: 'Sends after this turn · tap to steer' })
    expect(queueToggle('queue', true)).toMatchObject({ queues: false, label: 'Steering the running turn' })
  })
})

describe('held message rows', () => {
  const held = { remote_q: { threadId: 't', messageId: 'remote_q', text: 'x', queuedAt: 1 } }
  it('finds the held message for a live row and a history row', () => {
    expect(heldTurnFor(held, 'remote_q')?.text).toBe('x')
    expect(heldTurnFor(held, 'h-remote_q')?.text).toBe('x')
    expect(heldTurnFor(held, 'remote_other')).toBeUndefined()
    expect(heldTurnFor(undefined, 'remote_q')).toBeUndefined()
  })
  it('offers Send now except where the provider cannot steer', () => {
    expect(heldTurnActions('claude')).toEqual({ canPromote: true, hint: 'Runs after this turn' })
    const opencode = heldTurnActions('opencode')
    expect(opencode.canPromote).toBe(false)
    expect(opencode.hint).toMatch(/OpenCode/)
  })
})
