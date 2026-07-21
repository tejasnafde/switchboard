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
import type { Project, SessionSummary } from '@shared/types'
import { AppChannels } from '@shared/ipc-channels'
import type { MachineStatus } from '../components/sidebar/machineList'
import { projectsToSnapshot } from '../components/sidebar/machineSnapshot'
import { applyProjectOrder } from '../components/sidebar/sidebar-helpers'
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
  /** Local forwarded port of each connected machine's code-server (remote IDE). */
  idePorts: Record<string, number>
  /** Which machine the active chat is attached to. 'local' by default. */
  activeMachineId: string
  /** Collapsed machine nodes in the sidebar (ids). */
  collapsed: Set<string>
  /** ~/.ssh/config candidates for the Add-machine picker. */
  sshHosts: SshHost[]
  /** machineId -> cached tree snapshot for offline read-only browse. */
  snapshots: Record<string, MachineSnapshot>
  /**
   * machineId -> full live Project[] (everything the trimmed snapshot drops:
   * timestamps, counts, worktrees). Populated on each syncMachine; the
   * sidebar renders it only while the machine is connected.
   */
  projects: Record<string, Project[]>
  /** machineId -> human-readable reason for the last 'error' status (null once cleared). */
  lastError: Record<string, string | null>
  /** machineId -> current connect-phase detail ("npm install…"), only while connecting. */
  progress: Record<string, string | null>
  /** machineId -> true while an errored connection is auto-reconnecting. */
  reconnecting: Record<string, boolean>

  hydrate: () => Promise<void>
  add: (input: MachineInput) => Promise<Machine | null>
  update: (id: string, patch: Partial<MachineInput>) => Promise<void>
  remove: (id: string) => Promise<void>
  reorder: (ids: string[]) => Promise<void>
  loadSshHosts: () => Promise<void>
  loadSnapshots: () => Promise<void>
  /** Scan a connected remote's projects and cache them for offline browse. */
  syncMachine: (id: string) => Promise<void>
  /** Reorder a connected machine's projects; persists to the REMOTE's own projectOrder setting. */
  reorderMachineProjects: (machineId: string, paths: string[]) => Promise<void>
  /** Optimistically add a just-created chat to a machine's snapshot so its row
   *  appears immediately (a rescan can't see an empty conversation yet). */
  addSnapshotSession: (machineId: string, projectPath: string, session: { id: string; title: string; agentType?: string | null }) => void
  /** Patch a cached session's title in whichever snapshot holds it, so the
   *  sidebar row tracks renames (auto-title, manual) without a full re-sync. */
  renameSnapshotSession: (sessionId: string, title: string) => void
  /** Optimistically drop a session from a machine's snapshot (archive). */
  removeSnapshotSession: (machineId: string, sessionId: string) => void
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
  idePorts: {},
  activeMachineId: 'local',
  collapsed: new Set(),
  sshHosts: [],
  snapshots: {},
  projects: {},
  lastError: {},
  progress: {},
  reconnecting: {},

  hydrate: async () => {
    const api = window.api?.machines
    if (!api) return
    try {
      set({ remotes: await api.list() })
    } catch (err) {
      log.warn('hydrate failed', err)
      return
    }
    // Resync from main's live connection state: after a renderer reload the
    // preload transports are gone even though main's tunnels are still up.
    // Re-dial connected machines and rebind their project paths, or id-keyed
    // routing resolves to a machine with no registered transport.
    try {
      const statuses = await api.getStatuses()
      const connections = { ...get().connections }
      const idePorts = { ...get().idePorts }
      for (const [machineId, { status, url, idePort }] of Object.entries(statuses)) {
        // Only dial when the store didn't know about the connection (i.e. a
        // reload wiped the transports). hydrate() also runs after add/update/
        // remove, and connectMachine tears down + replaces the socket - doing
        // that to a healthy transport rejects its in-flight invokes.
        if (status === 'connected' && url && connections[machineId] !== 'connected') {
          window.api.routing.connectMachine(machineId, url)
          bindSnapshotPaths(machineId, get().snapshots[machineId])
        }
        connections[machineId] = toMachineStatus(status)
        if (status === 'connected' && idePort) idePorts[machineId] = idePort
      }
      set({ connections, idePorts })
    } catch (err) {
      log.warn('status resync failed', err)
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
      const projects = { ...s.projects }
      delete connections[id]
      delete snapshots[id]
      delete projects[id]
      return { connections, snapshots, projects }
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
      const fetched = await window.api.routing.invokeOn<Project[]>(id, AppChannels.GET_PROJECTS)
      // The remote keeps its own project order (same settings key, its DB).
      let order: string[] | null = null
      try {
        const raw = await window.api.routing.invokeOn<string | null>(id, 'settings:get', 'projectOrder')
        if (raw) order = JSON.parse(raw)
      } catch (err) {
        log.warn('remote projectOrder read failed, using scan order', err)
      }
      const ordered = applyProjectOrder(fetched, order)
      const snapshot = projectsToSnapshot(ordered, Date.now())
      await window.api.machines.saveSnapshot(id, snapshot)
      set((s) => ({
        snapshots: { ...s.snapshots, [id]: snapshot },
        projects: { ...s.projects, [id]: ordered },
      }))
      // Route path-keyed IPC (files/git/kanban/workspace) for every project
      // on this machine to it, not just the id-keyed session/terminal calls.
      bindSnapshotPaths(id, snapshot)
    } catch (err) {
      log.warn('syncMachine failed', err)
    }
  },

  reorderMachineProjects: async (machineId, paths) => {
    // Optimistic local reorder; persistence goes to the machine's own DB so
    // the order survives reconnects and is per-machine, not per-desktop.
    // The offline snapshot is reordered too, or a disconnect before the next
    // sync would show the pre-drag order.
    const current = get().projects[machineId]
    if (!current) return
    const byPath = new Map(current.map((p) => [p.path, p]))
    const next = paths.map((p) => byPath.get(p)).filter((p): p is Project => !!p)
    const snapshot = projectsToSnapshot(next, get().snapshots[machineId]?.syncedAt ?? Date.now())
    set((s) => ({
      projects: { ...s.projects, [machineId]: next },
      snapshots: { ...s.snapshots, [machineId]: snapshot },
    }))
    try {
      await window.api.machines.saveSnapshot(machineId, snapshot)
      await window.api.routing.invokeOn(machineId, 'settings:set', 'projectOrder', JSON.stringify(paths))
    } catch (err) {
      log.warn('remote project reorder persist failed', err)
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
      // Mirror onto the live tree too - a connected machine renders
      // s.projects, so patching only the snapshot would hide the new row
      // until the next full sync.
      const liveTree = s.projects[machineId]
      const live = liveTree?.some((p) => p.path === projectPath)
        ? liveTree.map((p) => {
            if (p.path !== projectPath || p.sessions.some((x) => x.id === session.id)) return p
            const summary: SessionSummary = {
              id: session.id,
              title: session.title,
              source: session.agentType === 'codex' ? 'codex' : session.agentType === 'opencode' ? 'opencode' : 'claude-code',
              agentType: session.agentType ?? null,
              startedAt: Date.now(),
              messageCount: 0,
              filePath: '',
            }
            return { ...p, sessions: [summary, ...p.sessions] }
          })
        : liveTree
      return {
        snapshots: { ...s.snapshots, [machineId]: { ...snap, projects } },
        ...(live ? { projects: { ...s.projects, [machineId]: live } } : {}),
      }
    }),

  renameSnapshotSession: (sessionId, title) =>
    set((s) => {
      let changed = false
      const snapshots = { ...s.snapshots }
      for (const [machineId, snap] of Object.entries(s.snapshots)) {
        if (!snap.projects.some((p) => p.sessions.some((x) => x.id === sessionId))) continue
        changed = true
        snapshots[machineId] = {
          ...snap,
          projects: snap.projects.map((p) =>
            p.sessions.some((x) => x.id === sessionId)
              ? { ...p, sessions: p.sessions.map((x) => (x.id === sessionId ? { ...x, title } : x)) }
              : p,
          ),
        }
      }
      // Mirror onto whichever live tree holds the session (see addSnapshotSession).
      const projects = { ...s.projects }
      for (const [machineId, tree] of Object.entries(s.projects)) {
        if (!tree.some((p) => p.sessions.some((x) => x.id === sessionId))) continue
        changed = true
        projects[machineId] = tree.map((p) =>
          p.sessions.some((x) => x.id === sessionId)
            ? { ...p, sessions: p.sessions.map((x) => (x.id === sessionId ? { ...x, title } : x)) }
            : p,
        )
      }
      return changed ? { snapshots, projects } : {}
    }),

  removeSnapshotSession: (machineId, sessionId) =>
    set((s) => {
      const snap = s.snapshots[machineId]
      if (!snap) return {}
      const projects = snap.projects.map((p) =>
        p.sessions.some((x) => x.id === sessionId)
          ? { ...p, sessions: p.sessions.filter((x) => x.id !== sessionId) }
          : p,
      )
      // Mirror onto the live tree (see addSnapshotSession).
      const liveTree = s.projects[machineId]
      const live = liveTree?.map((p) =>
        p.sessions.some((x) => x.id === sessionId)
          ? { ...p, sessions: p.sessions.filter((x) => x.id !== sessionId) }
          : p,
      )
      return {
        snapshots: { ...s.snapshots, [machineId]: { ...snap, projects } },
        ...(live ? { projects: { ...s.projects, [machineId]: live } } : {}),
      }
    }),

  connect: async (id) => {
    const failLocal = (reason: string) =>
      set((s) => ({
        connections: { ...s.connections, [id]: 'error' },
        lastError: { ...s.lastError, [id]: reason },
      }))
    set((s) => ({
      connections: { ...s.connections, [id]: 'connecting' },
      progress: { ...s.progress, [id]: null },
    }))
    try {
      const res = await window.api.machines.connect(id)
      if (!res.ok) {
        failLocal(res.error ?? 'connect rejected')
        log.warn('connect rejected', res.error)
      }
    } catch (err) {
      failLocal(err instanceof Error ? err.message : String(err))
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
    window.api.machines.onStatus((id, status, url, reason, willRetry, idePort) => {
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
        const progress = { ...s.progress }
        const reconnecting = { ...s.reconnecting }
        if (status === 'error') {
          lastError[id] = reason ?? null
          progress[id] = null
          reconnecting[id] = !!willRetry
        } else if (status === 'connecting') {
          lastError[id] = null
          // reason doubles as progress detail on repeated connecting emissions
          progress[id] = reason ?? progress[id] ?? null
          reconnecting[id] = false
        } else {
          // connected clears the error; offline keeps it (a deliberate
          // disconnect after a failure shouldn't erase why it failed)
          if (status === 'connected') lastError[id] = null
          progress[id] = null
          reconnecting[id] = false
        }
        const idePorts = { ...s.idePorts }
        // A dead tunnel means a dead forward - IdePane must fall back to its
        // waiting state, not render a webview at a dead port.
        if (status === 'connected' && idePort) idePorts[id] = idePort
        else delete idePorts[id]
        return { connections: { ...s.connections, [id]: toMachineStatus(status) }, idePorts, lastError, progress, reconnecting }
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
