/**
 * machine-store: the logic-bearing bits (optimistic reorder, collapse toggle,
 * mutate-then-rehydrate). window.api.machines is faked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useMachineStore } from '../../src/renderer/stores/machine-store'
import { useAgentStore } from '../../src/renderer/stores/agent-store'
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
const connectApi = vi.fn(async () => ({ ok: true as const }))
const reorder = vi.fn(async () => ({ ok: true as const }))
let statusCb: ((id: string, status: string, url: string | null, reason?: string, detail?: string) => void) | null = null
let connSnapshot: Array<{ machineId: string; status: string; url: string | null }> = []
const getConnections = vi.fn(async () => connSnapshot)
let treeSnapshots: Record<string, { syncedAt: number; projects: Array<{ path: string; name: string; sessions: never[] }> }> = {}
const getSnapshots = vi.fn(async () => treeSnapshots)
const connectMachine = vi.fn()
const disconnectMachine = vi.fn()
const bind = vi.fn()
const invokeOn = vi.fn(async () => [{ path: '/r/api', name: 'api', sessions: [{ id: 's1', title: 't1', source: 'codex', startedAt: 0, messageCount: 1, filePath: '/x' }] }])
const saveSnapshot = vi.fn(async () => ({ ok: true as const }))

beforeEach(() => {
  stored = [mk('a', 0), mk('b', 1), mk('c', 2)]
  statusCb = null
  connSnapshot = []
  treeSnapshots = {}
  useAgentStore.setState({ sessions: [] })
  ;(globalThis as { window?: unknown }).window = {
    api: {
      machines: {
        list: vi.fn(async () => stored),
        create,
        update: vi.fn(async () => null),
        delete: del,
        connect: connectApi,
        disconnect,
        reorder,
        listSshHosts: vi.fn(async () => []),
        saveSnapshot,
        getSnapshots,
        getConnections,
        onStatus: vi.fn((cb) => {
          statusCb = cb
          return () => {}
        }),
      },
      routing: { connectMachine, disconnectMachine, invokeOn, bind },
    },
  }
  useMachineStore.setState({ remotes: [], connections: {}, activeMachineId: 'local', collapsed: new Set(), sshHosts: [], snapshots: {}, lastError: {}, connectionDetail: {}, connectStartedAt: {} })
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

  it('add auto-connects the new machine without blocking on the connect', async () => {
    await useMachineStore.getState().add({ name: 'd', sshHost: 'd.host' })
    // The mock create keys the machine id off its name.
    expect(connectApi).toHaveBeenCalledWith('d')
    // connect() flips the status optimistically before its IPC resolves.
    expect(useMachineStore.getState().connections.d).toBe('connecting')
  })

  it('add catches a rejected create instead of throwing, and does not connect', async () => {
    create.mockRejectedValueOnce(new Error('tunnel down'))
    const result = await useMachineStore.getState().add({ name: 'd', sshHost: 'd.host' })
    expect(result).toBeNull()
    expect(connectApi).not.toHaveBeenCalled()
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

  it('renameSnapshotSession patches the title of a cached session in whichever snapshot holds it', () => {
    useMachineStore.setState((s) => ({
      snapshots: {
        ...s.snapshots,
        m1: { syncedAt: 0, projects: [{ path: '/r/api', name: 'api', sessions: [{ id: 's1', title: 'New conversation', agentType: null }] }] },
        m2: { syncedAt: 0, projects: [{ path: '/r/web', name: 'web', sessions: [{ id: 's2', title: 'keep me', agentType: null }] }] },
      },
    }))
    useMachineStore.getState().renameSnapshotSession('s1', 'create a claude.local.md')
    const { snapshots } = useMachineStore.getState()
    expect(snapshots.m1.projects[0].sessions[0].title).toBe('create a claude.local.md')
    expect(snapshots.m2.projects[0].sessions[0].title).toBe('keep me')
  })

  it('removeSnapshotSession drops the session from its project and leaves others alone', () => {
    useMachineStore.setState((s) => ({
      snapshots: {
        ...s.snapshots,
        m1: {
          syncedAt: 0,
          projects: [{ path: '/r/api', name: 'api', sessions: [{ id: 's1', title: 'a', agentType: null }, { id: 's2', title: 'b', agentType: null }] }],
        },
      },
    }))
    useMachineStore.getState().removeSnapshotSession('m1', 's1')
    expect(useMachineStore.getState().snapshots.m1.projects[0].sessions.map((x) => x.id)).toEqual(['s2'])
  })

  it('renameSnapshotSession is a no-op for an unknown session id', () => {
    const before = useMachineStore.getState().snapshots
    useMachineStore.getState().renameSnapshotSession('nope', 'x')
    expect(useMachineStore.getState().snapshots).toBe(before)
  })

  it('subscribeStatus does not register a transport while still connecting', () => {
    useMachineStore.getState().subscribeStatus()
    statusCb!('m1', 'connecting', null)
    expect(connectMachine).not.toHaveBeenCalled()
    expect(disconnectMachine).not.toHaveBeenCalled()
  })

  it('hydrate rebuilds routing from the main-process connection snapshot after a renderer reload', async () => {
    // Fresh renderer: no connections state, no status event pending - only
    // main's snapshot knows m1 is connected.
    connSnapshot = [{ machineId: 'm1', status: 'connected', url: 'ws://127.0.0.1:7681' }]
    treeSnapshots = { m1: { syncedAt: 0, projects: [{ path: '/r/api', name: 'api', sessions: [] }] } }
    await useMachineStore.getState().hydrate()
    expect(useMachineStore.getState().connections.m1).toBe('connected')
    expect(connectMachine).toHaveBeenCalledWith('m1', 'ws://127.0.0.1:7681')
    // Pulled the cached trees itself (loadSnapshots runs concurrently in App)
    // and bound the project paths.
    expect(bind).toHaveBeenCalledWith('/r/api', 'm1')
  })

  it('hydrate rebinds open agent sessions bound to a snapshot-connected machine', async () => {
    connSnapshot = [{ machineId: 'm1', status: 'connected', url: 'ws://127.0.0.1:7681' }]
    useAgentStore.getState().addSession({ id: 'sess-remote', type: 'terminal', status: 'idle', machineId: 'm1' })
    useAgentStore.getState().addSession({ id: 'sess-local', type: 'terminal', status: 'idle' })
    await useMachineStore.getState().hydrate()
    expect(bind).toHaveBeenCalledWith('sess-remote', 'm1')
    expect(bind).not.toHaveBeenCalledWith('sess-local', expect.anything())
  })

  it('hydrate applies snapshot statuses but a live status event that already landed wins', async () => {
    useMachineStore.setState((s) => ({ connections: { ...s.connections, m1: 'reconnecting' } }))
    connSnapshot = [
      { machineId: 'm1', status: 'connected', url: 'ws://127.0.0.1:7681' },
      { machineId: 'm2', status: 'error', url: null },
    ]
    await useMachineStore.getState().hydrate()
    expect(useMachineStore.getState().connections.m1).toBe('reconnecting')
    expect(useMachineStore.getState().connections.m2).toBe('error')
  })

  it('hydrate registers no transport for non-connected snapshot machines', async () => {
    connSnapshot = [{ machineId: 'm1', status: 'reconnecting', url: null }]
    await useMachineStore.getState().hydrate()
    expect(useMachineStore.getState().connections.m1).toBe('reconnecting')
    expect(connectMachine).not.toHaveBeenCalled()
  })

  it('hydrate survives a rejecting getConnections (older backend) without losing the machine list', async () => {
    getConnections.mockRejectedValueOnce(new Error('no handler: machines:get-connections'))
    await useMachineStore.getState().hydrate()
    expect(useMachineStore.getState().remotes.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('hydrate rebinds project paths for machines that are already connected', async () => {
    useMachineStore.setState((s) => ({
      connections: { ...s.connections, m1: 'connected' },
      snapshots: { ...s.snapshots, m1: { syncedAt: 0, projects: [{ path: '/r/api', name: 'api', sessions: [] }] } },
    }))
    await useMachineStore.getState().hydrate()
    expect(bind).toHaveBeenCalledWith('/r/api', 'm1')
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

  it('subscribeStatus treats provisioning like connecting: no transport registration, lastError cleared', () => {
    useMachineStore.getState().subscribeStatus()
    statusCb!('m1', 'error', null, 'boom')
    statusCb!('m1', 'provisioning', null, undefined, 'npm install (this can take a minute)')
    expect(connectMachine).not.toHaveBeenCalled()
    expect(disconnectMachine).not.toHaveBeenCalled()
    expect(useMachineStore.getState().connections.m1).toBe('provisioning')
    expect(useMachineStore.getState().lastError.m1).toBeNull()
  })

  it('subscribeStatus keeps bindings on reconnecting and does NOT set lastError', () => {
    useMachineStore.getState().subscribeStatus()
    statusCb!('m1', 'connected', 'ws://127.0.0.1:7681')
    statusCb!('m1', 'reconnecting', null, 'tunnel died')
    expect(disconnectMachine).not.toHaveBeenCalled()
    expect(useMachineStore.getState().connections.m1).toBe('reconnecting')
    expect(useMachineStore.getState().lastError.m1).toBeNull()
  })

  it('subscribeStatus tracks the progress detail per event and clears it when absent', () => {
    useMachineStore.getState().subscribeStatus()
    statusCb!('m1', 'provisioning', null, undefined, 'upload server bundle')
    expect(useMachineStore.getState().connectionDetail.m1).toBe('upload server bundle')
    statusCb!('m1', 'connecting', null, undefined, 'waiting for server…')
    expect(useMachineStore.getState().connectionDetail.m1).toBe('waiting for server…')
    statusCb!('m1', 'connected', 'ws://127.0.0.1:7681')
    expect(useMachineStore.getState().connectionDetail.m1).toBeNull()
  })

  it('subscribeStatus stamps connectStartedAt entering connecting from idle and clears it on connected', () => {
    useMachineStore.getState().subscribeStatus()
    statusCb!('m1', 'connecting', null)
    const started = useMachineStore.getState().connectStartedAt.m1
    expect(started).toBeTypeOf('number')

    // connecting -> provisioning is the same attempt - no restamp.
    statusCb!('m1', 'provisioning', null, undefined, 'npm install (this can take a minute)')
    expect(useMachineStore.getState().connectStartedAt.m1).toBe(started)

    statusCb!('m1', 'connected', 'ws://127.0.0.1:7681')
    expect(useMachineStore.getState().connectStartedAt.m1).toBeNull()
  })

  it('subscribeStatus clears connectStartedAt on terminal error and offline', () => {
    useMachineStore.getState().subscribeStatus()
    statusCb!('m1', 'connecting', null)
    statusCb!('m1', 'error', null, 'no route to host')
    expect(useMachineStore.getState().connectStartedAt.m1).toBeNull()

    statusCb!('m2', 'connecting', null)
    statusCb!('m2', 'offline', null)
    expect(useMachineStore.getState().connectStartedAt.m2).toBeNull()
  })

  it('subscribeStatus keeps the original connectStartedAt ticking through reconnecting', () => {
    useMachineStore.getState().subscribeStatus()
    statusCb!('m1', 'connecting', null)
    const started = useMachineStore.getState().connectStartedAt.m1
    statusCb!('m1', 'reconnecting', null, 'tunnel died')
    expect(useMachineStore.getState().connectStartedAt.m1).toBe(started)
  })

  it('connect() stamps connectStartedAt optimistically before main answers', async () => {
    await useMachineStore.getState().connect('m1')
    expect(useMachineStore.getState().connectStartedAt.m1).toBeTypeOf('number')
  })

  it('disconnect() clears the connect-phase detail and start time', async () => {
    useMachineStore.setState((s) => ({
      connections: { ...s.connections, m1: 'provisioning' },
      connectionDetail: { ...s.connectionDetail, m1: 'npm install (this can take a minute)' },
      connectStartedAt: { ...s.connectStartedAt, m1: 123 },
    }))
    await useMachineStore.getState().disconnect('m1')
    expect(useMachineStore.getState().connections.m1).toBe('offline')
    expect(useMachineStore.getState().connectionDetail.m1).toBeNull()
    expect(useMachineStore.getState().connectStartedAt.m1).toBeNull()
  })

  it('toggleCollapsed flips membership', () => {
    const { toggleCollapsed } = useMachineStore.getState()
    toggleCollapsed('a')
    expect(useMachineStore.getState().collapsed.has('a')).toBe(true)
    toggleCollapsed('a')
    expect(useMachineStore.getState().collapsed.has('a')).toBe(false)
  })
})
