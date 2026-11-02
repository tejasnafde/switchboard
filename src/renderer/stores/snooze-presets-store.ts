/**
 * The Snooze presets every desktop menu resolves when it opens (the row menu,
 * the narrow "..." menu, the context submenu, the palette), read from this
 * desktop's backend and kept current by its broadcast. The defaults until the
 * first read answers, or when it fails.
 */
import { create } from 'zustand'
import { DEFAULT_SNOOZE_PRESETS, parsePresetList, type SnoozePresetSpec } from '@shared/chat-snooze'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('store:snooze-presets')

interface SnoozePresetsStore {
  presets: readonly SnoozePresetSpec[]
  /** The backend answered at least once. */
  loaded: boolean
  take: (presets: unknown) => void
}

export const useSnoozePresetsStore = create<SnoozePresetsStore>((set) => ({
  presets: DEFAULT_SNOOZE_PRESETS,
  loaded: false,
  take: (presets) => set({ presets: parsePresetList(presets), loaded: true }),
}))

export function snoozePresets(): readonly SnoozePresetSpec[] {
  return useSnoozePresetsStore.getState().presets
}

let stop: (() => void) | null = null

/** Read the presets and follow the broadcast, once per window. Answers the stop, for tests. */
export function startSnoozePresetsSync(): () => void {
  if (stop) return stop
  const api = window.api.app
  let live = true
  // A broadcast is newer than a read that was already out.
  let pushed = false
  const off = api.onSnoozePresetsChanged((event) => {
    pushed = true
    useSnoozePresetsStore.getState().take(event.presets)
  })
  api.getSnoozePresets().then(
    (presets) => {
      if (live && !pushed) useSnoozePresetsStore.getState().take(presets)
    },
    (err: unknown) => log.warn('reading the snooze presets failed; the menus use the defaults', err),
  )
  stop = () => {
    live = false
    off()
    stop = null
  }
  return stop
}
