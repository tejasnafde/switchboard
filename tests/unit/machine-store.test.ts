/**
 * machine-store: the logic-bearing bits (optimistic reorder, collapse toggle,
 * mutate-then-rehydrate). window.api.machines is faked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useMachineStore } from '../../src/renderer/stores/machine-store'
import type { Machine } from '@shared/machines'

const mk = (id: string, sortOrder: number): Machine => ({
  id, name: id, sshAlias: null, sshHost: `${id}.host`, sshUser: null,
  sshPort: 22, sortOrder, createdAt: sortOrder, updatedAt: sortOrder,
})

let stored: Machine[] = []
const create = vi.fn(async (input: { name: string }) => {
  const m = mk(input.name, stored.length)
  stored.push(m)
  return m
})
const del = vi.fn(async (id: string) => {
  stored = stored.filter((m) => m.id !== id)
  return { ok: true as const }
})
const disconnect = vi.fn(async () => ({ ok: true as const }))
const reorder = vi.fn(async () => ({ ok: true as const }))
let statusCb: ((id: string, status: string, url: string | null, reason?: string) => void) | null = null
const connectMachine = vi.fn()
const disconnectMachine = vi.fn()
const bind = vi.fn()
const invokeOn = vi.fn(async () => [{ path: '/r/api', name: 'api', sessions: [{ id: 's1', title: 't1', source: 'codex', startedAt: 0, messageCount: 1, filePath: '/x' }] }])
const saveSnapshot = vi.fn(async () => ({ ok: true as const }))
let liveStatuses: Record<string, { status: string; url: string | null }> = {}
const getStatuses = vi.fn(async () => liveStatuses)

beforeEach(() => {
  stored = [mk('a', 0), mk('b', 1), mk('c', 2)]
  statusCb = null
  ;(globalThis as { window?: unknown }).window = {
    api: {
      machines: {
        list: vi.fn(async () => stored),
        create,
        update: vi.fn(async () => null),
        delete: del,
        disconnect,
        reorder,
        listSshHosts: vi.fn(async () => []),
        saveSnapshot,
        getStatuses,
        onStatus: vi.fn((cb) => {
          statusCb = cb
          return () => {}
        }),
      },
      routing: { connectMachine, disconnectMachine, invokeOn, bind },
    },
  }
  liveStatuses = {}
  useMachineStore.setState({ remotes: [], connections: {}, activeMachineId: 'local', collapsed: new Set(), sshHosts: [], snapshots: {}, lastError: {}, progress: {}, reconnecting: {} })
  vi.clearAllMocks()
})

describe('machine-store', () => {
  it('hydrate pulls the machine list from main', async () => {
    await useMachineStore.getState().hydrate()
    expect(useMachineStore.getState().remotes.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('reorder applies the new order optimistically, rewrites sortOrder, and persists', async () => {
    await useMachineStore.getState().hydrate()
    await useMachineStore.getState().reorder(['c', 'a', 'b'])
    const remotes = useMachineStore.getState().remotes
    expect(remotes.map((m) => m.id)).toEqual(['c', 'a', 'b'])
    // Without rewriting sortOrder, buildMachineList (which sorts by it) would
    // snap the list back to the original order on the next hydrate/render.
    expect(remotes.map((m) => m.sortOrder)).toEqual([0, 1, 2])
    expect(reorder).toHaveBeenCalledWith(['c', 'a', 'b'])
  })

  it('add creates then re-hydrates', async () => {
    await useMachineStore.getState().add({ name: 'd', sshHost: 'd.host' })
    expect(create).toHaveBeenCalled()
    expect(useMachineStore.getState().remotes.some((m) => m.id === 'd')).toBe(true)
  })

  it('add catches a rejected create instead of throwing', async () => {
    create.mockRejectedValueOnce(new Error('tunnel down'))
    const result = await useMachineStore.getState().add({ name: 'd', sshHost: 'd.host' })
    expect(result).toBeNull()
  })

  it('remove deletes then re-hydrates', async () => {
    await useMachineStore.getState().hydrate()
    await useMachineStore.getState().remove('b')
    expect(del).toHaveBeenCalledWith('b')
    expect(useMachineStore.getState().remotes.map((m) => m.id)).toEqual(['a', 'c'])
  })

  it('remove disconnects a live machine first, then prunes its cached state', async () => {
    await useMachineStore.getState().hydrate()
    useMachineStore.setState((s) => ({
      connections: { ...s.connections, b: 'connected' },
      snapshots: { ...s.snapshots, b: { syncedAt: 0, projects: [] } },
    }))
    await useMachineStore.getState().remove('b')
    expect(disconnect).toHaveBeenCalledWith('b')
    expect(del).toHaveBeenCalledWith('b')
    expect(useMachineStore.getState().connections.b).toBeUndefined()
    expect(useMachineStore.getState().snapshots.b).toBeUndefined()
  })

  it('remove does not disconnect an already-offline machine', async () => {
    await useMachineStore.getState().hydrate()
    await useMachineStore.getState().remove('a')
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('subscribeStatus registers a remote transport on connect and tears it down on an intentional disconnect', () => {
    useMachineStore.getState().subscribeStatus()
    statusCb!('m1', 'connected', 'ws://127.0.0.1:7681')
    expect(connectMachine).toHaveBeenCalledWith('m1', 'ws://127.0.0.1:7681')
    expect(useMachineStore.getState().connections.m1).toBe('connected')

    statusCb!('m1', 'offline', null)
    expect(disconnectMachine).toHaveBeenCalledWith('m1')
    expect(useMachineStore.getState().connections.m1).toBe('offline')
  })

  it('subscribeStatus does NOT tear down bindings on a transient error - the transport can reconnect', () => {
    useMachineStore.getState().subscribeStatus()
    statusCb!('m1', 'connected', 'ws://127.0.0.1:7681')
    statusCb!('m1', 'error', null)
    expect(disconnectMachine).not.toHaveBeenCalled()
    expect(useMachineStore.getState().connections.m1).toBe('error')
  })

  it('subscribeStatus falls back to offline for an unrecognized status', () => {
    useMachineStore.getState().subscribeStatus()
    statusCb!('m1', 'weird-future-status', null)
    expect(useMachineStore.getState().connections.m1).toBe('offline')
  })

  it('syncMachine scans the remote, persists, caches the snapshot, and binds its project paths', async () => {
    await useMachineStore.getState().syncMachine('m1')
    expect(invokeOn).toHaveBeenCalledWith('m1', 'app:get-projects')
    expect(saveSnapshot).toHaveBeenCalled()
    const snap = useMachineStore.getState().snapshots.m1
    expect(snap.projects).toEqual([{ path: '/r/api', name: 'api', sessions: [{ id: 's1', title: 't1', agentType: 'codex' }] }])
    expect(bind).toHaveBeenCalledWith('/r/api', 'm1')
  })

  it('subscribeStatus does not register a transport while still connecting', () => {
    useMachineStore.getState().subscribeStatus()
    statusCb!('m1', 'connecting', null)
    expect(connectMachine).not.toHaveBeenCalled()
    expect(disconnectMachine).not.toHaveBeenCalled()
  })

  it('hydrate re-dials and rebinds machines main reports as connected (renderer-reload resync)', async () => {
    // Simulates a renderer reload: main still holds a live tunnel, but the
    // preload transports and store connections were wiped with the page.
    liveStatuses = { m1: { status: 'connected', url: 'ws://127.0.0.1:7681' } }
    useMachineStore.setState((s) => ({
      snapshots: { ...s.snapshots, m1: { syncedAt: 0, projects: [{ path: '/r/api', name: 'api', sessions: [] }] } },
    }))
    await useMachineStore.getState().hydrate()
    expect(connectMachine).toHaveBeenCalledWith('m1', 'ws://127.0.0.1:7681')
    expect(bind).toHaveBeenCalledWith('/r/api', 'm1')
    expect(useMachineStore.getState().connections.m1).toBe('connected')
  })

  it('hydrate does NOT re-dial a machine the store already knows is connected (add/update/remove path)', async () => {
    liveStatuses = { m1: { status: 'connected', url: 'ws://127.0.0.1:7681' } }
    useMachineStore.setState((s) => ({ connections: { ...s.connections, m1: 'connected' } }))
    await useMachineStore.getState().hydrate()
    // Re-dialing tears down the live transport and rejects in-flight invokes.
    expect(connectMachine).not.toHaveBeenCalled()
  })

  it('hydrate survives a missing getStatuses handler (older main)', async () => {
    getStatuses.mockRejectedValueOnce(new Error('no handler'))
    await useMachineStore.getState().hydrate()
    expect(useMachineStore.getState().remotes.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('subscribeStatus stores progress detail on connecting and reconnecting on a will-retry error', () => {
    useMachineStore.getState().subscribeStatus()
    statusCb!('m1', 'connecting', null, 'npm install (this can take a minute)')
    expect(useMachineStore.getState().progress.m1).toBe('npm install (this can take a minute)')

    statusCb!('m1', 'error', null, 'tunnel closed: Connection refused', true)
    expect(useMachineStore.getState().reconnecting.m1).toBe(true)
    expect(useMachineStore.getState().progress.m1).toBeNull()

    statusCb!('m1', 'error', null, 'gave up')
    expect(useMachineStore.getState().reconnecting.m1).toBe(false)
  })

  it('connect records the rejection reason in lastError instead of a bare error pip', async () => {
    ;(window as unknown as { api: { machines: { connect: unknown } } }).api.machines.connect =
      vi.fn(async () => ({ ok: false, error: 'unknown machine' }))
    await useMachineStore.getState().connect('m1')
    expect(useMachineStore.getState().connections.m1).toBe('error')
    expect(useMachineStore.getState().lastError.m1).toBe('unknown machine')
  })

  it('subscribeStatus records the reason in lastError on an error transition', () => {
    useMachineStore.getState().subscribeStatus()
    statusCb!('m1', 'error', null, 'no node runtime found on the remote')
    expect(useMachineStore.getState().lastError.m1).toBe('no node runtime found on the remote')
  })

  it('subscribeStatus clears lastError on connecting and connected', () => {
    useMachineStore.getState().subscribeStatus()
    statusCb!('m1', 'error', null, 'health check failed (timeout)')
    expect(useMachineStore.getState().lastError.m1).toBe('health check failed (timeout)')

    statusCb!('m1', 'connecting', null)
    expect(useMachineStore.getState().lastError.m1).toBeNull()

    statusCb!('m1', 'error', null, 'boom')
    statusCb!('m1', 'connected', 'ws://127.0.0.1:7681')
    expect(useMachineStore.getState().lastError.m1).toBeNull()
  })

  it('toggleCollapsed flips membership', () => {
    const { toggleCollapsed } = useMachineStore.getState()
    toggleCollapsed('a')
    expect(useMachineStore.getState().collapsed.has('a')).toBe(true)
    toggleCollapsed('a')
    expect(useMachineStore.getState().collapsed.has('a')).toBe(false)
  })
})
