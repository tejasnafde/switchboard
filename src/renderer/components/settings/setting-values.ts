/**
 * Where each value-holding Settings row reads and writes, keyed by the row id
 * in `settings-rows.ts`. The page loads them all on open, so the navigation
 * can count changed rows on pages that are not showing. Each binding goes
 * through the same store or service the setting used before this page.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { parseFollowUpDefault } from '@shared/turn-delivery'
import { useLayoutStore } from '../../stores/layout-store'
import { useThemeStore, type ThemeName } from '../../stores/theme-store'
import { areNotificationsEnabled, setNotificationsEnabled } from '../../services/notifications'
import { getDefaultSessionEnvMode, setDefaultSessionEnvMode, type SessionEnvMode } from '../../services/session-env-mode'
import { isAssistantStreamingEnabled, setAssistantStreamingEnabled } from '../../services/streaming-pref'
import { isAnalyticsEnabled, setAnalyticsEnabled } from '../../services/analytics-pref'
import {
  RECENT_SESSION_LIMIT_CHANGED,
  RECENT_SESSION_LIMIT_SETTING,
  parseRecentSessionLimit,
} from '../sidebar/recent-session-limit'
import { SETTING_ROW } from './settings-rows'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('settings:values')

interface Binding {
  read: () => Promise<string>
  write: (value: string) => Promise<void> | void
}

const flag = (on: boolean) => String(on)

const BINDINGS: Record<string, Binding> = {
  [SETTING_ROW.notifyTurnEnd.id]: {
    read: async () => flag(await areNotificationsEnabled()),
    write: (v) => setNotificationsEnabled(v === 'true'),
  },
  [SETTING_ROW.recentLimit.id]: {
    read: async () => String(parseRecentSessionLimit(await window.api.settings.get(RECENT_SESSION_LIMIT_SETTING))),
    write: async (v) => {
      await window.api.settings.set(RECENT_SESSION_LIMIT_SETTING, v)
      window.dispatchEvent(new CustomEvent(RECENT_SESSION_LIMIT_CHANGED, { detail: Number(v) }))
    },
  },
  [SETTING_ROW.ideIdleTtl.id]: {
    read: async () => (await window.api.settings.get('ide.idleTtlMinutes')) ?? '5',
    // The field holds what was typed; only a positive number is stored.
    write: async (v) => {
      const n = parseFloat(v)
      if (!Number.isFinite(n) || n <= 0) return
      await window.api.settings.set('ide.idleTtlMinutes', String(n))
      window.dispatchEvent(new Event('sb-ide-settings-changed'))
    },
  },
  [SETTING_ROW.analytics.id]: {
    read: async () => flag(await isAnalyticsEnabled()),
    write: (v) => setAnalyticsEnabled(v === 'true'),
  },
  [SETTING_ROW.theme.id]: {
    read: async () => useThemeStore.getState().theme,
    write: (v) => useThemeStore.getState().setTheme(v as ThemeName),
  },
  [SETTING_ROW.followUp.id]: {
    read: async () => useLayoutStore.getState().followUpDefault,
    write: (v) => useLayoutStore.getState().setFollowUpDefault(parseFollowUpDefault(v)),
  },
  [SETTING_ROW.streaming.id]: {
    read: async () => flag(await isAssistantStreamingEnabled()),
    write: (v) => setAssistantStreamingEnabled(v === 'true'),
  },
  [SETTING_ROW.envMode.id]: {
    read: () => getDefaultSessionEnvMode(),
    write: (v) => setDefaultSessionEnvMode(v as SessionEnvMode),
  },
  [SETTING_ROW.fileDiffs.id]: {
    read: async () => flag(useLayoutStore.getState().showFileDiffCards),
    write: (v) => useLayoutStore.getState().setShowFileDiffCards(v === 'true'),
  },
  [SETTING_ROW.tourAutoplay.id]: {
    read: async () => flag((await window.api.settings.get('tour.autoplay')) !== 'false'),
    write: (v) => window.api.settings.set('tour.autoplay', v),
  },
}

export interface SettingValues {
  values: Readonly<Record<string, string>>
  set: (id: string, value: string) => void
}

export function useSettingValues(): SettingValues {
  const [values, setValues] = useState<Record<string, string>>({})
  // A read that lands after the user already picked a value must not undo it.
  const touched = useRef(new Set<string>())

  useEffect(() => {
    let cancelled = false
    for (const [id, binding] of Object.entries(BINDINGS)) {
      binding.read()
        .then((value) => {
          if (!cancelled && !touched.current.has(id)) setValues((prev) => ({ ...prev, [id]: value }))
        })
        .catch((err) => log.warn(`reading ${id} failed`, err))
    }
    return () => { cancelled = true }
  }, [])

  const set = useCallback((id: string, value: string) => {
    touched.current.add(id)
    setValues((prev) => ({ ...prev, [id]: value }))
    const binding = BINDINGS[id]
    if (!binding) {
      log.warn(`no binding for ${id}`)
      return
    }
    Promise.resolve(binding.write(value)).catch((err) => log.warn(`writing ${id} failed`, err))
  }, [])

  return { values, set }
}

export const SETTING_BINDING_IDS: readonly string[] = Object.keys(BINDINGS)
