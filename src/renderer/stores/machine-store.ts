/**
 * Machine store - the user's remote (SSH) hosts plus per-machine connection
 * state. Source of truth lives in main (SQLite); this is a renderer cache,
 * hydrated on launch and re-hydrated after mutations. The local machine is
 * synthesized in the view layer (see buildMachineList), not stored here.
 *
 * Connection state is renderer-only for now (M2). Actual SSH-tunnel connect
 * lands in M4; until then everything reads `offline`.
 */
import { create } from 'zustand'
import type { Machine, MachineInput, SshHost, MachineSnapshot } from '@shared/machines'
import type { MachineStatus } from '../components/sidebar/machineList'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('store:machines')

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

  hydrate: () => Promise<void>
  add: (input: MachineInput) => Promise<Machine | null>
  update: (id: string, patch: Partial<MachineInput>) => Promise<void>
  remove: (id: string) => Promise<void>
  reorder: (ids: string[]) => Promise<void>
  loadSshHosts: () => Promise<void>
  loadSnapshots: () => Promise<void>
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

  hydrate: async () => {
    const api = window.api?.machines
    if (!api) return
    try {
      set({ remotes: await api.list() })
    } catch (err) {
      log.warn('hydrate failed', err)
    }
  },

  add: async (input) => {
    const created = await window.api.machines.create(input)
    await get().hydrate()
    return created
  },

  update: async (id, patch) => {
    await window.api.machines.update(id, patch)
    await get().hydrate()
  },

  remove: async (id) => {
    await window.api.machines.delete(id)
    await get().hydrate()
  },

  reorder: async (ids) => {
    // Optimistic: apply the new order locally, then persist.
    const byId = new Map(get().remotes.map((m) => [m.id, m]))
    set({ remotes: ids.map((id) => byId.get(id)).filter((m): m is Machine => !!m) })
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

  setActive: (id) => set({ activeMachineId: id }),

  toggleCollapsed: (id) =>
    set((s) => {
      const next = new Set(s.collapsed)
      next.has(id) ? next.delete(id) : next.add(id)
      return { collapsed: next }
    }),
}))
