/**
 * The foreground rule decides whether returning to the app costs a cheap ping
 * or a full reconnect. Both wrong answers are user-visible: probing a socket
 * the OS already killed adds a timeout before the inevitable, and reconnecting
 * after a two-second app switch throws away a healthy session.
 */
import { describe, it, expect } from 'vitest'
import { foregroundAction } from '../../apps/mobile/src/lib/app-lifecycle'

describe('foregroundAction', () => {
  it('probes after a short absence, where the socket has probably survived', () => {
    expect(foregroundAction(1_000, 1_000 + 2_000)).toBe('probe')
  })

  it('probes after a long absence without discarding a healthy socket', () => {
    expect(foregroundAction(1_000, 1_000 + 60_000)).toBe('probe')
  })

  it('treats the threshold itself as a long absence', () => {
    expect(foregroundAction(1_000, 1_000 + 10_000)).toBe('probe')
    expect(foregroundAction(1_000, 1_000 + 10_000 - 1)).toBe('probe')
  })

  it('probes when the app was never backgrounded', () => {
    // iOS fires `inactive` for a notification-shade pull or a control-centre
    // swipe. That is not an absence and must not churn the connection.
    expect(foregroundAction(null, Date.now())).toBe('probe')
  })
})
