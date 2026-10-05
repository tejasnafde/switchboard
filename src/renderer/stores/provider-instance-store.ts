/**
 * Renderer-side store for provider instances.
 *
 * One in-memory copy of the list, fetched lazily on first read and
 * refreshed after every mutation. Components subscribe and re-render
 * when the user adds/edits/deletes an instance.
 */

import { create } from 'zustand'
import type { ProviderInstance } from '@shared/types'
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
  /** Reads every enabled instance not yet read at its current version in
   *  this Accounts visit (main drops its cached reading when one is saved). */
  syncUsage: () => void
  /** Starts an Accounts visit: the next syncUsage reads every account once.
   *  Nothing else reads usage unasked, since a Claude read can be a macOS
   *  password prompt per keychain item. */
  beginUsageVisit: () => void
  clearError: () => void
}

type UsageOpts = { force?: boolean; refreshWithTurn?: boolean }

const usageReads = new Map<string, Promise<void>>()
/** A forced read asked for while one was in flight, run once it settles. */
const queuedUsage = new Map<string, UsageOpts>()
/** Instance id -> the version last read in this Accounts visit. */
const requestedUsage = new Map<string, string>()

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
    // Main hands a second request the read already in flight, which may
    // predate an edit, so a forced one waits for it and then reads again.
    const running = usageReads.get(id)
    if (running) {
      if (opts?.force || opts?.refreshWithTurn) {
        queuedUsage.set(id, { force: true, refreshWithTurn: queuedUsage.get(id)?.refreshWithTurn || opts.refreshWithTurn })
      }
      return running
    }
    set((s) => ({ usageLoading: { ...s.usageLoading, [id]: true } }))
    const task = get().usage(id, opts).then((usage) => {
      usageReads.delete(id)
      const next = queuedUsage.get(id)
      queuedUsage.delete(id)
      set((s) => {
        const usageLoading = { ...s.usageLoading }
        if (!next) delete usageLoading[id]
        return { usages: { ...s.usages, [id]: usage }, usageLoading }
      })
      if (next) return get().loadUsage(id, next)
    })
    usageReads.set(id, task)
    return task
  },

  syncUsage: () => {
    for (const inst of get().instances) {
      const version = `${inst.id}@${inst.updatedAt}`
      const previous = requestedUsage.get(inst.id)
      if (!inst.enabled || previous === version) continue
      requestedUsage.set(inst.id, version)
      // Edited since the last read: main's cached reading is for the old credential.
      void get().loadUsage(inst.id, previous === undefined ? undefined : { force: true })
    }
  },

  beginUsageVisit: () => {
    requestedUsage.clear()
  },

  clearError: () => set({ error: null }),
}))
