/**
 * Renderer-side store for provider instances.
 *
 * One in-memory copy of the list, fetched lazily on first read and
 * refreshed after every mutation. Components subscribe and re-render
 * when the user adds/edits/deletes an instance.
 */

import { create } from 'zustand'
import { defaultInstanceId, type ProviderInstance, type AgentType } from '@shared/types'
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
  clearError: () => void
  /** Helper: instances filtered to a given agent kind, in a stable order
   *  (default first, then alpha). Used by both the picker and the
   *  Settings tab. */
  forAgent: (agentType: AgentType) => ProviderInstance[]
}

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
