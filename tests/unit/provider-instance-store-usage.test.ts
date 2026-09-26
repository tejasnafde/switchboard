import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderUsage } from '../../src/shared/provider-usage'
import type { ProviderInstance } from '../../src/shared/types'

type Call = { id: string; opts: unknown; resolve: (u: ProviderUsage) => void }
const calls: Call[] = []

vi.stubGlobal('window', {
  api: {
    providerInstances: {
      usage: (id: string, opts: unknown) => new Promise<ProviderUsage>((resolve) => calls.push({ id, opts, resolve })),
    },
  },
})

const { useProviderInstanceStore } = await import('../../src/renderer/stores/provider-instance-store')

const reading = (id: string, message: string): ProviderUsage => ({
  instanceId: id, agentType: 'claude-code', status: 'not-applicable', plan: null, account: null,
  windows: [], overage: [], message, fetchedAtMs: 0,
})
const inst = (updatedAt: number) => ({ id: 'a', agentType: 'claude-code', enabled: true, updatedAt }) as ProviderInstance
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('provider-instance-store usage reads', () => {
  beforeEach(() => { calls.length = 0 })

  it('re-reads, forced, an account edited while its first read was in flight', async () => {
    const store = useProviderInstanceStore
    store.setState({ instances: [inst(1)] })
    store.getState().syncUsage()
    store.setState({ instances: [inst(2)] })
    store.getState().syncUsage()
    store.getState().syncUsage()
    expect(calls).toHaveLength(1)

    calls[0].resolve(reading('a', 'old credential'))
    await flush()
    expect(calls).toHaveLength(2)
    expect(calls[1].opts).toEqual({ force: true, refreshWithTurn: undefined })
    expect(store.getState().usageLoading.a).toBe(true)

    calls[1].resolve(reading('a', 'new credential'))
    await flush()
    expect(calls).toHaveLength(2)
    expect(store.getState().usages.a.message).toBe('new credential')
    expect(store.getState().usageLoading.a).toBeUndefined()
  })

  it('folds several forced requests during one read into one follow-up, keeping refreshWithTurn', async () => {
    const store = useProviderInstanceStore.getState()
    void store.loadUsage('b')
    void store.loadUsage('b', { refreshWithTurn: true })
    void store.loadUsage('b', { force: true })
    calls[0].resolve(reading('b', 'first'))
    await flush()
    expect(calls.map((c) => c.opts)).toEqual([undefined, { force: true, refreshWithTurn: true }])
  })
})
