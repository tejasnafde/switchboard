/**
 * A settings.json save wrote settings behind this window's back: re-read the
 * ones it changed into the stores and caches that hold them, then tell an
 * open Settings page to re-read its rows. Nothing here writes, so adopting
 * the file cannot rewrite it.
 */
import { FOLLOW_UP_DEFAULT_KEY, parseFollowUpDefault } from '@shared/turn-delivery'
import { FALLBACK_RUNTIME_MODE, SETTING_DEFAULT_RUNTIME_MODE } from '@shared/session-defaults'
import { isRuntimeMode } from '@shared/provider-events'
import { PROJECT_OVERRIDE_PREFIX, SETTING_SESSION_ENV_MODE, SETTING_SHOW_FILE_DIFFS } from '@shared/project-settings'
import { KEYBOARD_OVERRIDES_SETTING } from '@shared/shortcuts'
import { useThemeStore } from '../stores/theme-store'
import { useLayoutStore } from '../stores/layout-store'
import { setStoreDefaultRuntimeMode } from '../stores/agent-store'
import { useProjectSettingsStore } from '../stores/project-settings-store'
import { invalidateNotificationCache } from './notifications'
import { invalidateStreamingCache } from './streaming-pref'
import { invalidateAnalyticsCache } from './analytics-pref'
import { invalidateSessionEnvModeCache } from './session-env-mode'
import { reloadKeyboardOverrides } from './keyboard-overrides'
import {
  RECENT_SESSION_LIMIT_CHANGED,
  RECENT_SESSION_LIMIT_SETTING,
  parseRecentSessionLimit,
} from '../components/sidebar/recent-session-limit'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('service:settings-file')

/** Window event: settings changed outside the Settings page; its rows re-read. */
export const SETTINGS_CHANGED_ELSEWHERE = 'sb-settings-changed-elsewhere'

const get = (key: string): Promise<string | null> => window.api.settings.get(key)

const ADOPT: Record<string, () => Promise<void> | void> = {
  theme: async () => useThemeStore.getState().adoptStoredTheme(await get('theme')),
  [FOLLOW_UP_DEFAULT_KEY]: async () =>
    useLayoutStore.setState({ followUpDefault: parseFollowUpDefault(await get(FOLLOW_UP_DEFAULT_KEY)) }),
  [SETTING_SHOW_FILE_DIFFS]: async () =>
    useLayoutStore.setState({ showFileDiffCards: (await get(SETTING_SHOW_FILE_DIFFS)) === 'true' }),
  [SETTING_DEFAULT_RUNTIME_MODE]: async () => {
    const mode = await get(SETTING_DEFAULT_RUNTIME_MODE)
    setStoreDefaultRuntimeMode(isRuntimeMode(mode) ? mode : FALLBACK_RUNTIME_MODE)
  },
  [SETTING_SESSION_ENV_MODE]: invalidateSessionEnvModeCache,
  notificationsEnabled: invalidateNotificationCache,
  assistantStreamingEnabled: invalidateStreamingCache,
  'analytics.enabled': invalidateAnalyticsCache,
  [RECENT_SESSION_LIMIT_SETTING]: async () => {
    const limit = parseRecentSessionLimit(await get(RECENT_SESSION_LIMIT_SETTING))
    window.dispatchEvent(new CustomEvent(RECENT_SESSION_LIMIT_CHANGED, { detail: limit }))
  },
  'ide.idleTtlMinutes': () => {
    window.dispatchEvent(new Event('sb-ide-settings-changed'))
  },
  [KEYBOARD_OVERRIDES_SETTING]: reloadKeyboardOverrides,
}

export async function adoptChangedSettings(keys: readonly string[]): Promise<void> {
  const tasks: unknown[] = keys.filter((key) => key in ADOPT).map((key) => ADOPT[key]())
  if (keys.some((key) => key.startsWith(PROJECT_OVERRIDE_PREFIX))) {
    const store = useProjectSettingsStore.getState()
    tasks.push(store.load(Object.keys(store.byProject)))
  }
  const results = await Promise.allSettled(tasks)
  for (const result of results) {
    if (result.status === 'rejected') log.warn('re-reading a setting from settings.json failed', result.reason)
  }
  window.dispatchEvent(new Event(SETTINGS_CHANGED_ELSEWHERE))
}

/** Subscribe for the window's lifetime; answers the unsubscribe. */
export function attachSettingsFileSync(): () => void {
  if (typeof window.api?.settingsFile?.onApplied !== 'function') return () => {}
  return window.api.settingsFile.onApplied((keys) => {
    void adoptChangedSettings(keys)
  })
}
