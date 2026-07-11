/**
 * nextConnectionStatus: the pure connect-lifecycle transition used by both the
 * main-process connection manager and the sidebar pip.
 */
import { describe, it, expect } from 'vitest'
import { nextConnectionStatus } from '../../src/main/machines/connectionStatus'

describe('nextConnectionStatus', () => {
  it('connect moves offline/error -> connecting', () => {
    expect(nextConnectionStatus('offline', 'connect')).toBe('connecting')
    expect(nextConnectionStatus('error', 'connect')).toBe('connecting')
  })
  it('healthy moves connecting -> connected', () => {
    expect(nextConnectionStatus('connecting', 'healthy')).toBe('connected')
  })
  it('fail moves any active state -> error', () => {
    expect(nextConnectionStatus('connecting', 'fail')).toBe('error')
    expect(nextConnectionStatus('connected', 'fail')).toBe('error')
  })
  it('disconnect always returns to offline', () => {
    expect(nextConnectionStatus('connected', 'disconnect')).toBe('offline')
    expect(nextConnectionStatus('connecting', 'disconnect')).toBe('offline')
  })
  it('ignores healthy unless connecting (no spurious connect)', () => {
    expect(nextConnectionStatus('offline', 'healthy')).toBe('offline')
    expect(nextConnectionStatus('connected', 'healthy')).toBe('connected')
  })

  it('provision moves connecting -> provisioning', () => {
    expect(nextConnectionStatus('connecting', 'provision')).toBe('provisioning')
  })

  it('provision does not resurrect inactive states', () => {
    expect(nextConnectionStatus('offline', 'provision')).toBe('offline')
    expect(nextConnectionStatus('error', 'provision')).toBe('error')
    expect(nextConnectionStatus('connected', 'provision')).toBe('connected')
  })

  it('connect moves provisioning back to connecting (tunnel + health phase)', () => {
    expect(nextConnectionStatus('provisioning', 'connect')).toBe('connecting')
  })

  it('retry moves any failed/active state to reconnecting', () => {
    expect(nextConnectionStatus('connected', 'retry')).toBe('reconnecting')
    expect(nextConnectionStatus('connecting', 'retry')).toBe('reconnecting')
    expect(nextConnectionStatus('provisioning', 'retry')).toBe('reconnecting')
    expect(nextConnectionStatus('error', 'retry')).toBe('reconnecting')
  })

  it('retry after a deliberate disconnect stays offline', () => {
    expect(nextConnectionStatus('offline', 'retry')).toBe('offline')
  })

  it('a retry attempt keeps the reconnecting badge through connect and provision', () => {
    expect(nextConnectionStatus('reconnecting', 'connect')).toBe('reconnecting')
    expect(nextConnectionStatus('reconnecting', 'provision')).toBe('reconnecting')
  })

  it('healthy moves provisioning/reconnecting -> connected', () => {
    expect(nextConnectionStatus('provisioning', 'healthy')).toBe('connected')
    expect(nextConnectionStatus('reconnecting', 'healthy')).toBe('connected')
  })

  it('fail and disconnect are terminal from the new states too', () => {
    expect(nextConnectionStatus('provisioning', 'fail')).toBe('error')
    expect(nextConnectionStatus('reconnecting', 'fail')).toBe('error')
    expect(nextConnectionStatus('provisioning', 'disconnect')).toBe('offline')
    expect(nextConnectionStatus('reconnecting', 'disconnect')).toBe('offline')
  })
})
