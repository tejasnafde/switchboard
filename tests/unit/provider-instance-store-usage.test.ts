import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderUsage } from '../../src/shared/provider-usage'
import type { ProviderInstance } from '../../src/shared/types'

type Call = { id: string; opts: unknown; resolve: (u: ProviderUsage) => void }
const calls: Call[] = []
let listed: ProviderInstance[] = []

vi.stubGlobal('window', {
  api: {
    providerInstances: {
      usage: (id: string, opts: unknown) => new Promise<ProviderUsage>((resolve) => calls.push({ id, opts, resolve })),
      list: async () => listed,
    },
  },
})

const { useProviderInstanceStore } = await import('../../src/renderer/stores/provider-instance-store')

const reading = (id: string, message: string): ProviderUsage => ({
  instanceId: id,
  agentType: 'claude-code',
  status: 'not-applicable',
  plan: null,
  account: null,
  windows: [],
  overage: [],
  message,
  fetchedAtMs: 0,
})
const inst = (updatedAt: number, id = 'a') =>
  ({ id, agentType: 'claude-code', enabled: true, updatedAt }) as ProviderInstance
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('provider-instance-store usage reads', () => {
  beforeEach(() => {
    calls.length = 0
  })

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

  it('reads no usage when Settings opens, only the account list', async () => {
    listed = [inst(1, 's1'), inst(1, 's2')]
    // What SettingsPage runs on open, on any page.
    await useProviderInstanceStore.getState().refresh()
    expect(useProviderInstanceStore.getState().instances).toHaveLength(2)
    expect(calls).toHaveLength(0)
  })

  it('reads each account once per Accounts visit', async () => {
    const store = useProviderInstanceStore
    store.setState({ instances: [inst(1, 'v1'), inst(1, 'v2')] })
    const visit = () => {
      store.getState().beginUsageVisit()
      store.getState().syncUsage()
    }
    visit()
    // A re-render, or StrictMode running the effects twice.
    store.getState().syncUsage()
    visit()
    expect(calls.map((c) => [c.id, c.opts])).toEqual([
      ['v1', undefined],
      ['v2', undefined],
    ])
    for (const c of calls) c.resolve(reading(c.id, 'read'))
    await flush()

    visit()
    expect(calls.map((c) => c.id)).toEqual(['v1', 'v2', 'v1', 'v2'])
    expect(calls.slice(2).map((c) => c.opts)).toEqual([undefined, undefined])
    for (const c of calls.slice(2)) c.resolve(reading(c.id, 'read'))
    await flush()
  })
})
