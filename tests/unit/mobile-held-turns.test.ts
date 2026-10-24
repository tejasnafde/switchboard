import { describe, expect, it } from 'vitest'
import { heldTurnActions, heldTurnFor, queueToggle } from '../../apps/mobile/src/lib/held-turns'

describe('phone steer/queue segment', () => {
  it('selects Steer with the Steer default, and a tap queues once', () => {
    expect(queueToggle('steer', false)).toMatchObject({
      queues: false,
      label: 'Steer',
      hint: 'Steering the running turn · tap to queue',
      accessibilityLabel: 'Send after this turn instead of steering it',
    })
    expect(queueToggle('steer', true)).toMatchObject({ queues: true, label: 'Queue', hint: 'Sends after this turn' })
  })
  it('selects Queue with the Queue default, and a tap steers once', () => {
    expect(queueToggle('queue', false)).toMatchObject({
      queues: true,
      label: 'Queue',
      hint: 'Sends after this turn · tap to steer',
      accessibilityLabel: 'Steer the running turn instead of queueing',
    })
    expect(queueToggle('queue', true)).toMatchObject({
      queues: false,
      label: 'Steer',
      hint: 'Steering the running turn',
    })
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
    expect(heldTurnActions('claude')).toEqual({
      label: 'Queued',
      canPromote: true,
      canResume: false,
      hint: 'Runs after this turn',
    })
    const opencode = heldTurnActions('opencode')
    expect(opencode.canPromote).toBe(false)
    expect(opencode.hint).toMatch(/OpenCode/)
  })
  it('offers Resume on a held queue, and only Cancel on a message that could not start', () => {
    const turn = held.remote_q
    expect(heldTurnActions('claude', { ...turn, held: true })).toMatchObject({
      label: 'Held',
      canPromote: false,
      canResume: true,
    })
    expect(heldTurnActions('claude', { ...turn, failed: 'usage limit' })).toEqual({
      label: 'Not sent',
      canPromote: false,
      canResume: false,
      hint: 'usage limit',
    })
  })
})
