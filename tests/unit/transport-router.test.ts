/**
 * TransportRouter: per-session backend routing. invoke/send go to the machine
 * the resolver names (default 'local'); on() fans out to every registered
 * transport - including ones registered later - so live events from local and
 * remote backends merge in one window.
 */
import { describe, it, expect, vi } from 'vitest'
import { TransportRouter } from '../../src/preload/transport-router'
import type { Transport } from '@shared/transport'

function fake(tag: string) {
  const handlers = new Map<string, Set<(...a: unknown[]) => void>>()
  const t: Transport & { invoked: Array<[string, unknown[]]>; emit: (ch: string, ...a: unknown[]) => void } = {
    invoked: [],
    invoke: vi.fn(async (ch: string, ...args: unknown[]) => {
      t.invoked.push([ch, args])
      return tag
    }),
    send: vi.fn((ch: string, ...args: unknown[]) => {
      t.invoked.push([ch, args])
    }),
    on: (ch, handler) => {
      const set = handlers.get(ch) ?? new Set()
      set.add(handler as (...a: unknown[]) => void)
      handlers.set(ch, set)
      return () => set.delete(handler as (...a: unknown[]) => void)
    },
    emit: (ch, ...a) => handlers.get(ch)?.forEach((h) => h(...a)),
  }
  return t
}

describe('TransportRouter', () => {
  it('routes invoke/send to local by default', async () => {
    const local = fake('local')
    const router = new TransportRouter(local)
    expect(await router.invoke('app:x')).toBe('local')
    router.send('app:y', 1)
    expect(local.invoked).toEqual([['app:x', []], ['app:y', [1]]])
  })

  it('routes to the machine the resolver names', async () => {
    const local = fake('local')
    const remote = fake('remote')
    const router = new TransportRouter(local, (_ch, args) => (args[0] === 'on-remote' ? 'm1' : 'local'))
    router.register('m1', remote)
    await router.invoke('provider:send', 'on-remote')
    await router.invoke('provider:send', 'on-local')
    expect(remote.invoked).toEqual([['provider:send', ['on-remote']]])
    expect(local.invoked).toEqual([['provider:send', ['on-local']]])
  })

  it('falls back to local when the resolver names an unregistered machine', async () => {
    const local = fake('local')
    const router = new TransportRouter(local, () => 'ghost')
    expect(await router.invoke('app:x')).toBe('local')
    expect(local.invoked).toHaveLength(1)
  })

  it('fans out on() to every registered transport', () => {
    const local = fake('local')
    const remote = fake('remote')
    const router = new TransportRouter(local)
    router.register('m1', remote)
    const seen: string[] = []
    router.on('provider:event', (e) => seen.push(e as string))
    local.emit('provider:event', 'from-local')
    remote.emit('provider:event', 'from-remote')
    expect(seen).toEqual(['from-local', 'from-remote'])
  })

  it('attaches existing subscriptions to a transport registered later', () => {
    const local = fake('local')
    const router = new TransportRouter(local)
    const seen: string[] = []
    router.on('provider:event', (e) => seen.push(e as string))
    const remote = fake('remote')
    router.register('m1', remote)
    remote.emit('provider:event', 'late')
    expect(seen).toEqual(['late'])
  })

  it('unregister detaches subscriptions and stops routing to the machine', async () => {
    const local = fake('local')
    const remote = fake('remote')
    const router = new TransportRouter(local, () => 'm1')
    router.register('m1', remote)
    const seen: string[] = []
    router.on('e', (x) => seen.push(x as string))
    router.unregister('m1')
    remote.emit('e', 'gone')
    expect(seen).toEqual([])
    await router.invoke('x') // m1 gone -> falls back to local
    expect(local.invoked).toEqual([['x', []]])
  })

  it('refuses to unregister local', async () => {
    const local = fake('local')
    const router = new TransportRouter(local)
    router.unregister('local')
    expect(await router.invoke('x')).toBe('local')
  })

  it('unsubscribe detaches from all transports', () => {
    const local = fake('local')
    const remote = fake('remote')
    const router = new TransportRouter(local)
    router.register('m1', remote)
    const seen: string[] = []
    const off = router.on('e', (x) => seen.push(x as string))
    off()
    local.emit('e', 'a')
    remote.emit('e', 'b')
    expect(seen).toEqual([])
  })
})
