/**
 * TransportRouter: per-session backend routing. invoke/send go to the machine
 * the resolver names (default 'local'); on() fans out to every registered
 * transport - including ones registered later - so live events from local and
 * remote backends merge in one window.
 */
import { describe, it, expect, vi } from 'vitest'
import { TransportRouter, shouldReplaceTransport } from '../../src/preload/transport-router'
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

  it('throws instead of silently falling back to local when the resolver names an unregistered machine', async () => {
    const local = fake('local')
    const router = new TransportRouter(local, () => 'ghost')
    await expect(router.invoke('app:x')).rejects.toThrow('machine not connected: ghost')
    expect(local.invoked).toHaveLength(0)
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

  it('unregister detaches subscriptions and throws on subsequent routing to the machine', async () => {
    const local = fake('local')
    const remote = fake('remote')
    const router = new TransportRouter(local, () => 'm1')
    router.register('m1', remote)
    const seen: string[] = []
    router.on('e', (x) => seen.push(x as string))
    router.unregister('m1')
    remote.emit('e', 'gone')
    expect(seen).toEqual([])
    // m1 is gone - must not silently execute the call on the Mac instead.
    await expect(router.invoke('x')).rejects.toThrow('machine not connected: m1')
    expect(local.invoked).toEqual([])
  })

  it('refuses to unregister local', async () => {
    const local = fake('local')
    const router = new TransportRouter(local)
    router.unregister('local')
    expect(await router.invoke('x')).toBe('local')
  })

  it('invokeOn targets a specific machine regardless of the resolver', async () => {
    const local = fake('local')
    const remote = fake('remote')
    const router = new TransportRouter(local) // default resolver -> local
    router.register('m1', remote)
    expect(await router.invokeOn('m1', 'app:get-projects')).toBe('remote')
    expect(remote.invoked).toEqual([['app:get-projects', []]])
  })

  it('invokeOn throws instead of falling back to local for an unregistered machine', async () => {
    const local = fake('local')
    const router = new TransportRouter(local)
    await expect(router.invokeOn('ghost', 'app:get-projects')).rejects.toThrow('machine not connected: ghost')
    expect(local.invoked).toHaveLength(0)
  })

  it('onWithSource tags each event with the machine id that emitted it', () => {
    const local = fake('local')
    const remote = fake('remote')
    const router = new TransportRouter(local)
    router.register('m1', remote)
    const seen: Array<[string, string]> = []
    router.onWithSource<[string]>('provider:event', (machineId, e) => seen.push([machineId, e]))
    local.emit('provider:event', 'from-local')
    remote.emit('provider:event', 'from-remote')
    expect(seen).toEqual([['local', 'from-local'], ['m1', 'from-remote']])
  })

  it('onWithSource tags events from a transport registered after subscribing', () => {
    const local = fake('local')
    const router = new TransportRouter(local)
    const seen: Array<[string, string]> = []
    router.onWithSource<[string]>('provider:event', (machineId, e) => seen.push([machineId, e]))
    const remote = fake('remote')
    router.register('m1', remote)
    remote.emit('provider:event', 'late')
    expect(seen).toEqual([['m1', 'late']])
  })

  it('on() delegates to onWithSource but drops the machine id from the handler', () => {
    const local = fake('local')
    const remote = fake('remote')
    const router = new TransportRouter(local)
    router.register('m1', remote)
    const seen: string[] = []
    router.on<[string]>('provider:event', (e) => seen.push(e))
    local.emit('provider:event', 'from-local')
    remote.emit('provider:event', 'from-remote')
    expect(seen).toEqual(['from-local', 'from-remote'])
  })

  it('unsubscribing an onWithSource fanout detaches from every transport', () => {
    const local = fake('local')
    const remote = fake('remote')
    const router = new TransportRouter(local)
    router.register('m1', remote)
    const seen: string[] = []
    const off = router.onWithSource<[string]>('e', (_machineId, x) => seen.push(x))
    off()
    local.emit('e', 'a')
    remote.emit('e', 'b')
    expect(seen).toEqual([])
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

describe('shouldReplaceTransport', () => {
  const t = (url: string, alive: boolean) => ({ url, isAlive: () => alive })

  it('registers fresh when there is no existing transport', () => {
    expect(shouldReplaceTransport(undefined, 'ws://127.0.0.1:7681')).toBe(true)
  })

  it('keeps an alive transport dialing the same url (idempotent reconnect echo)', () => {
    // A stable-port reconnect re-emits 'connected' with an unchanged url; the
    // transport heals in place, so tearing it down would drop every subscription.
    expect(shouldReplaceTransport(t('ws://127.0.0.1:7681', true), 'ws://127.0.0.1:7681')).toBe(false)
  })

  it('replaces when the url moved (port-stolen fallback allocated a new one)', () => {
    expect(shouldReplaceTransport(t('ws://127.0.0.1:7681', true), 'ws://127.0.0.1:7999')).toBe(true)
  })

  it('replaces a terminally-closed transport even on the same url', () => {
    // isAlive() is false only after a deliberate close() or an exhausted
    // reconnect budget - either way the old object will never carry traffic again.
    expect(shouldReplaceTransport(t('ws://127.0.0.1:7681', false), 'ws://127.0.0.1:7681')).toBe(true)
  })
})
