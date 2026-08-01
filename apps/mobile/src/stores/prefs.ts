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
  /** Unsent composer text, so leaving a chat does not discard it. */
  draft?: string
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

/**
 * Draft reducer, kept pure and outside the store: the store is wrapped in
 * `persist`, which cannot be imported in a node test without React Native's
 * AsyncStorage. Testing the rule here keeps the store a thin wrapper.
 */
export function withDraft(
  threads: Record<string, ThreadPref>,
  key: string,
  draft: string,
  now: number,
): Record<string, ThreadPref> | null {
  const current = threads[key]
  if ((current?.draft ?? '') === draft) return null
  // An emptied draft should not keep the entry alive on its own.
  if (draft === '' && current?.mode === undefined && current?.model === undefined) {
    if (current === undefined) return null
    const next = { ...threads }
    delete next[key]
    return next
  }
  return pruneThreadPrefs({ ...threads, [key]: { ...current, draft, at: now } })
}

interface PrefsState {
  threads: Record<string, ThreadPref>
  /** Mode a NEW session starts in - the last one the user chose. */
  defaultMode: RuntimeMode
  rememberMode: (key: string, mode: RuntimeMode) => void
  rememberModel: (key: string, model: string) => void
  rememberDraft: (key: string, draft: string) => void
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

      rememberDraft: (key, draft) =>
        set((s) => {
          const threads = withDraft(s.threads, key, draft, Date.now())
          return threads ? { threads } : {}
        }),

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
