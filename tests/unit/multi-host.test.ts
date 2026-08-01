/**
 * MultiHost fan-out: one handler set must serve every host (renderer + paired
 * phone) so both share a single registry, and emit must reach all of them even
 * if one host throws.
 */
import { describe, it, expect, vi } from 'vitest'
import { MultiHost } from '../../src/main/backend/multi-host'
import type { BackendHost } from '../../src/main/backend/host'

class FakeHost implements BackendHost {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  readonly listeners = new Map<string, (...args: unknown[]) => void>()
  readonly emitted: Array<{ channel: string; args: unknown[] }> = []
  constructor(private readonly emitThrows = false) {}
  handle<A extends unknown[]>(channel: string, fn: (...args: A) => unknown): void {
    this.handlers.set(channel, fn as (...args: unknown[]) => unknown)
  }
  on<A extends unknown[]>(channel: string, fn: (...args: A) => void): void {
    this.listeners.set(channel, fn as (...args: unknown[]) => void)
  }
  emit(channel: string, ...args: unknown[]): void {
    if (this.emitThrows) throw new Error('dead host')
    this.emitted.push({ channel, args })
  }
}

describe('MultiHost', () => {
  it('registers the same handler on every host', async () => {
    const a = new FakeHost()
    const b = new FakeHost()
    const multi = new MultiHost(a, b)
    const fn = vi.fn(() => 'result')
    multi.handle('provider:start-session', fn)

    expect(a.handlers.has('provider:start-session')).toBe(true)
    expect(b.handlers.has('provider:start-session')).toBe(true)
    // Same function object: a phone-side invoke runs identical code to the renderer's.
    expect(a.handlers.get('provider:start-session')).toBe(b.handlers.get('provider:start-session'))
    expect(await a.handlers.get('provider:start-session')!()).toBe('result')
  })

  it('subscribes send-style listeners on every host', () => {
    const a = new FakeHost()
    const b = new FakeHost()
    const multi = new MultiHost(a, b)
    multi.on('terminal:data', () => {})
    expect(a.listeners.has('terminal:data')).toBe(true)
    expect(b.listeners.has('terminal:data')).toBe(true)
  })

  it('broadcasts events to every host', () => {
    const a = new FakeHost()
    const b = new FakeHost()
    new MultiHost(a, b).emit('provider:event', { type: 'content', threadId: 't1' })

    expect(a.emitted).toHaveLength(1)
    expect(b.emitted).toHaveLength(1)
    expect(a.emitted[0].channel).toBe('provider:event')
  })

  it('a throwing host does not stop delivery to the others', () => {
    const dead = new FakeHost(true)
    const live = new FakeHost()
    new MultiHost(dead, live).emit('provider:event', 'payload')
    expect(live.emitted).toEqual([{ channel: 'provider:event', args: ['payload'] }])
  })

  it('works as a single-host passthrough', () => {
    const only = new FakeHost()
    const multi = new MultiHost(only)
    multi.handle('app:get-projects', () => [])
    multi.emit('x', 1)
    expect(only.handlers.has('app:get-projects')).toBe(true)
    expect(only.emitted).toHaveLength(1)
  })
})
