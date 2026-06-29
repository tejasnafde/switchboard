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
})
