/**
 * Client preferences that survive a restart, keyed `connectionId:threadId`.
 * Only choices about how THIS client drives a thread live here - anything the
 * desktop owns (projectOrder, workspaces) is read from the backend instead.
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { RuntimeMode } from '@shared/provider-events'

/** Bounded: the map is persisted, so it cannot grow per thread ever opened. */
export const MAX_REMEMBERED_THREADS = 200

export interface ThreadPref {
  mode?: RuntimeMode
  model?: string
  /** Last write, used to decide what to drop when over the cap. */
  at: number
}

/** Keep the most recently touched entries. Pure, so eviction is testable. */
export function pruneThreadPrefs(
  prefs: Record<string, ThreadPref>,
  max = MAX_REMEMBERED_THREADS,
): Record<string, ThreadPref> {
  const keys = Object.keys(prefs)
  if (keys.length <= max) return prefs
  const kept = keys.sort((a, b) => prefs[b].at - prefs[a].at).slice(0, max)
  const out: Record<string, ThreadPref> = {}
  for (const k of kept) out[k] = prefs[k]
  return out
}

interface PrefsState {
  threads: Record<string, ThreadPref>
  /** Mode a NEW session starts in - the last one the user chose. */
  defaultMode: RuntimeMode
  rememberMode: (key: string, mode: RuntimeMode) => void
  rememberModel: (key: string, model: string) => void
  forget: (key: string) => void
}

export const usePrefsStore = create<PrefsState>()(
  persist(
    (set) => ({
      threads: {},
      defaultMode: 'sandbox',

      rememberMode: (key, mode) =>
        set((s) => ({
          threads: pruneThreadPrefs({ ...s.threads, [key]: { ...s.threads[key], mode, at: Date.now() } }),
          // A mode chosen on one thread is the best guess for the next new one,
          // which is how the desktop composer behaves.
          defaultMode: mode,
        })),

      rememberModel: (key, model) =>
        set((s) => ({
          threads: pruneThreadPrefs({ ...s.threads, [key]: { ...s.threads[key], model, at: Date.now() } }),
        })),

      forget: (key) =>
        set((s) => {
          if (!(key in s.threads)) return {}
          const next = { ...s.threads }
          delete next[key]
          return { threads: next }
        }),
    }),
    {
      name: 'switchboard-prefs',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
)
