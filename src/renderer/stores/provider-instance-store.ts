/**
 * Renderer-side store for provider instances.
 *
 * One in-memory copy of the list, fetched lazily on first read and
 * refreshed after every mutation. Components subscribe and re-render
 * when the user adds/edits/deletes an instance.
 */

import { create } from 'zustand'
import { defaultInstanceId, type ProviderInstance, type AgentType } from '@shared/types'
import type { ProviderUsage } from '@shared/provider-usage'
import type { ProviderInstanceUpsertInput } from '../../preload'

interface ProviderInstanceStore {
  instances: ProviderInstance[]
  loaded: boolean
  loading: boolean
  /** Last error from any IPC call below; cleared on next successful refresh. */
  error: string | null
  refresh: () => Promise<void>
  upsert: (input: ProviderInstanceUpsertInput) => Promise<ProviderInstance>
  remove: (id: string) => Promise<boolean>
  test: (id: string) => Promise<{ ok: boolean; message: string }>
  /** Subscription usage for one instance. Never throws; failures come back
   *  as a ProviderUsage with a non-'ok' status. */
  usage: (id: string, opts?: UsageOpts) => Promise<ProviderUsage>
  /** Latest reading per instance id, kept across Settings visits so a
   *  reopened Accounts page shows it at once. */
  usages: Record<string, ProviderUsage>
  /** Ids with a read in flight; a card keeps its previous reading meanwhile. */
  usageLoading: Record<string, true>
  loadUsage: (id: string, opts?: UsageOpts) => Promise<void>
  /** Reads every enabled instance not yet read at its current version since
   *  the last prewarm (main drops its cached reading when one is saved). */
  syncUsage: () => void
  /** Re-list and read usage for every account; Settings calls it on open. */
  prewarmUsage: () => Promise<void>
  clearError: () => void
  /** Helper: instances filtered to a given agent kind, in a stable order
   *  (default first, then alpha). Used by both the picker and the
   *  Settings tab. */
  forAgent: (agentType: AgentType) => ProviderInstance[]
}

type UsageOpts = { force?: boolean; refreshWithTurn?: boolean }

const usageReads = new Map<string, Promise<void>>()
const requestedUsage = new Set<string>()

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const useProviderInstanceStore = create<ProviderInstanceStore>((set, get) => ({
  instances: [],
  loaded: false,
  loading: false,
  error: null,

  refresh: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      const list = await window.api.providerInstances.list()
      set({ instances: list, loaded: true, loading: false, error: null })
    } catch (err) {
      set({ loading: false, error: `Failed to load provider instances: ${asMessage(err)}` })
    }
  },

  upsert: async (input) => {
    try {
      const next = await window.api.providerInstances.upsert(input)
      await get().refresh()
      return next
    } catch (err) {
      set({ error: `Save failed: ${asMessage(err)}` })
      throw err
    }
  },

  remove: async (id) => {
    try {
      const ok = await window.api.providerInstances.delete(id)
      if (ok) await get().refresh()
      else set({ error: 'Cannot delete the last instance for this agent kind.' })
      return ok
    } catch (err) {
      set({ error: `Delete failed: ${asMessage(err)}` })
      throw err
    }
  },

  test: async (id) => {
    try {
      return await window.api.providerInstances.test(id)
    } catch (err) {
      return { ok: false, message: asMessage(err) }
    }
  },

  usage: async (id, opts) => {
    try {
      return await window.api.providerInstances.usage(id, opts)
    } catch (err) {
      return {
        instanceId: id,
        agentType: get().instances.find((i) => i.id === id)?.agentType ?? 'claude-code',
        status: 'error' as const,
        plan: null,
        account: null,
        windows: [],
        overage: [],
        message: asMessage(err),
        fetchedAtMs: Date.now(),
      }
    }
  },

  usages: {},
  usageLoading: {},

  loadUsage: (id, opts) => {
    // Main hands a second request the read already in flight, forced or not.
    const running = usageReads.get(id)
    if (running) return running
    set((s) => ({ usageLoading: { ...s.usageLoading, [id]: true } }))
    const task = get().usage(id, opts).then((usage) => {
      usageReads.delete(id)
      set((s) => {
        const usageLoading = { ...s.usageLoading }
        delete usageLoading[id]
        return { usages: { ...s.usages, [id]: usage }, usageLoading }
      })
    })
    usageReads.set(id, task)
    return task
  },

  syncUsage: () => {
    for (const inst of get().instances) {
      const version = `${inst.id}@${inst.updatedAt}`
      if (!inst.enabled || requestedUsage.has(version)) continue
      requestedUsage.add(version)
      void get().loadUsage(inst.id)
    }
  },

  prewarmUsage: async () => {
    requestedUsage.clear()
    await get().refresh()
    get().syncUsage()
  },

  clearError: () => set({ error: null }),

  forAgent: (agentType) =>
    get().instances
      .filter((i) => i.agentType === agentType && i.enabled)
      .sort((a, b) => {
        // Default rows first; then alpha by display name.
        const aDef = a.id === defaultInstanceId(agentType) ? 0 : 1
        const bDef = b.id === defaultInstanceId(agentType) ? 0 : 1
        if (aDef !== bDef) return aDef - bDef
        return a.displayName.localeCompare(b.displayName)
      }),
}))
