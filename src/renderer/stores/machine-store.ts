/**
 * Machine store - the user's remote (SSH) hosts plus per-machine connection
 * state. Source of truth lives in main (SQLite); this is a renderer cache,
 * hydrated on launch and re-hydrated after mutations. The local machine is
 * synthesized in the view layer (see buildMachineList), not stored here.
 *
 * Connection state is driven by the main-process ConnectionManager (M4b): the
 * renderer kicks off connect/disconnect and reflects the status events it emits.
 */
import { create } from 'zustand'
import type { Machine, MachineInput, SshHost, MachineSnapshot } from '@shared/machines'
import type { Project } from '@shared/types'
import { AppChannels } from '@shared/ipc-channels'
import type { MachineStatus } from '../components/sidebar/machineList'
import { projectsToSnapshot } from '../components/sidebar/machineSnapshot'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('store:machines')

const MACHINE_STATUSES: readonly MachineStatus[] = ['connected', 'connecting', 'offline', 'error']
function toMachineStatus(status: string): MachineStatus {
  return (MACHINE_STATUSES as readonly string[]).includes(status) ? (status as MachineStatus) : 'offline'
}

/**
 * Bind every cached project path in a snapshot to its machine, so path-keyed
 * IPC (files/git/kanban/workspace) routes to the remote instead of local.
 * Known ceiling: two machines with the same absolute project path collide -
 * the last bind wins.
 */
function bindSnapshotPaths(machineId: string, snapshot: MachineSnapshot | undefined): void {
  if (!snapshot) return
  for (const project of snapshot.projects) {
    window.api.routing.bind(project.path, machineId)
  }
}

interface MachineStore {
  remotes: Machine[]
  /** machineId -> live connection status (absent = offline). */
  connections: Record<string, MachineStatus>
  /** Which machine the active chat is attached to. 'local' by default. */
  activeMachineId: string
  /** Collapsed machine nodes in the sidebar (ids). */
  collapsed: Set<string>
  /** ~/.ssh/config candidates for the Add-machine picker. */
  sshHosts: SshHost[]
  /** machineId -> cached tree snapshot for offline read-only browse. */
  snapshots: Record<string, MachineSnapshot>
  /** machineId -> human-readable reason for the last 'error' status (null once cleared). */
  lastError: Record<string, string | null>

  hydrate: () => Promise<void>
  add: (input: MachineInput) => Promise<Machine | null>
  update: (id: string, patch: Partial<MachineInput>) => Promise<void>
  remove: (id: string) => Promise<void>
  reorder: (ids: string[]) => Promise<void>
  loadSshHosts: () => Promise<void>
  loadSnapshots: () => Promise<void>
  /** Scan a connected remote's projects and cache them for offline browse. */
  syncMachine: (id: string) => Promise<void>
  /** Optimistically add a just-created chat to a machine's snapshot so its row
   *  appears immediately (a rescan can't see an empty conversation yet). */
  addSnapshotSession: (machineId: string, projectPath: string, session: { id: string; title: string; agentType?: string | null }) => void
  connect: (id: string) => Promise<void>
  disconnect: (id: string) => Promise<void>
  /** Subscribe to main's per-machine status events. Returns an unsubscribe fn. */
  subscribeStatus: () => () => void
  setActive: (id: string) => void
  toggleCollapsed: (id: string) => void
}

export const useMachineStore = create<MachineStore>((set, get) => ({
  remotes: [],
  connections: {},
  activeMachineId: 'local',
  collapsed: new Set(),
  sshHosts: [],
  snapshots: {},
  lastError: {},

  hydrate: async () => {
    const api = window.api?.machines
    if (!api) return
    try {
      set({ remotes: await api.list() })
    } catch (err) {
      log.warn('hydrate failed', err)
      return
    }
    // Machines that reconnected before this hydrate resolved already have a
    // 'connected' status and a cached snapshot - rebind their project paths
    // so path-keyed IPC doesn't silently fall back to local after a reload.
    const { connections, snapshots } = get()
    for (const [machineId, status] of Object.entries(connections)) {
      if (status === 'connected') bindSnapshotPaths(machineId, snapshots[machineId])
    }
  },

  add: async (input) => {
    try {
      const created = await window.api.machines.create(input)
      await get().hydrate()
      return created
    } catch (err) {
      log.warn('add failed', err)
      return null
    }
  },

  update: async (id, patch) => {
    await window.api.machines.update(id, patch)
    await get().hydrate()
  },

  remove: async (id) => {
    // Disconnect first - deleting a live machine would leave its transport and bindings registered.
    if ((get().connections[id] ?? 'offline') !== 'offline') {
      await get().disconnect(id)
    }
    await window.api.machines.delete(id)
    await get().hydrate()
    set((s) => {
      const connections = { ...s.connections }
      const snapshots = { ...s.snapshots }
      delete connections[id]
      delete snapshots[id]
      return { connections, snapshots }
    })
  },

  reorder: async (ids) => {
    // Optimistic: apply the new order locally and rewrite sortOrder
    // sequentially, then persist. buildMachineList re-sorts by sortOrder,
    // so leaving the old values in place made the UI snap back to the
    // previous order until the next hydrate.
    const byId = new Map(get().remotes.map((m) => [m.id, m]))
    set({
      remotes: ids
        .map((id) => byId.get(id))
        .filter((m): m is Machine => !!m)
        .map((m, i) => ({ ...m, sortOrder: i })),
    })
    await window.api.machines.reorder(ids)
  },

  loadSshHosts: async () => {
    try {
      set({ sshHosts: await window.api.machines.listSshHosts() })
    } catch (err) {
      log.warn('loadSshHosts failed', err)
    }
  },

  loadSnapshots: async () => {
    try {
      set({ snapshots: await window.api.machines.getSnapshots() })
    } catch (err) {
      log.warn('loadSnapshots failed', err)
    }
  },

  syncMachine: async (id) => {
    try {
      const projects = await window.api.routing.invokeOn<Project[]>(id, AppChannels.GET_PROJECTS)
      const snapshot = projectsToSnapshot(projects, Date.now())
      await window.api.machines.saveSnapshot(id, snapshot)
      set((s) => ({ snapshots: { ...s.snapshots, [id]: snapshot } }))
      // Route path-keyed IPC (files/git/kanban/workspace) for every project
      // on this machine to it, not just the id-keyed session/terminal calls.
      bindSnapshotPaths(id, snapshot)
    } catch (err) {
      log.warn('syncMachine failed', err)
    }
  },

  addSnapshotSession: (machineId, projectPath, session) =>
    set((s) => {
      const snap = s.snapshots[machineId]
      if (!snap) return {}
      const projects = snap.projects.map((p) =>
        p.path === projectPath && !p.sessions.some((x) => x.id === session.id)
          ? { ...p, sessions: [{ id: session.id, title: session.title, agentType: session.agentType ?? null }, ...p.sessions] }
          : p,
      )
      return { snapshots: { ...s.snapshots, [machineId]: { ...snap, projects } } }
    }),

  connect: async (id) => {
    set((s) => ({ connections: { ...s.connections, [id]: 'connecting' } }))
    try {
      const res = await window.api.machines.connect(id)
      if (!res.ok) {
        set((s) => ({ connections: { ...s.connections, [id]: 'error' } }))
        log.warn('connect rejected', res.error)
      }
    } catch (err) {
      set((s) => ({ connections: { ...s.connections, [id]: 'error' } }))
      log.warn('connect failed', err)
    }
  },

  disconnect: async (id) => {
    try {
      await window.api.machines.disconnect(id)
    } catch (err) {
      log.warn('disconnect failed', err)
    }
    set((s) => ({ connections: { ...s.connections, [id]: 'offline' } }))
  },

  subscribeStatus: () =>
    window.api.machines.onStatus((id, status, url, reason) => {
      if (status === 'connected' && url) {
        // connectMachine() replaces a stale transport in place, covering reconnect-after-error.
        window.api.routing.connectMachine(id, url)
        void get().syncMachine(id)
      } else if (status === 'offline') {
        // Only intentional disconnects wipe bindings. 'error' is often a transient
        // tunnel blip that auto-reconnects; forgetting bindings would orphan live sessions.
        window.api.routing.disconnectMachine(id)
      }
      set((s) => {
        const lastError = { ...s.lastError }
        if (status === 'error') lastError[id] = reason ?? null
        else if (status === 'connecting' || status === 'connected') lastError[id] = null
        return { connections: { ...s.connections, [id]: toMachineStatus(status) }, lastError }
      })
    }),

  setActive: (id) => set({ activeMachineId: id }),

  toggleCollapsed: (id) =>
    set((s) => {
      const next = new Set(s.collapsed)
      next.has(id) ? next.delete(id) : next.add(id)
      return { collapsed: next }
    }),
}))
