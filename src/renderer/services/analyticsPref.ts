/**
 * "Share anonymous usage counts" preference plus the one-time first-launch
 * notice flag. Same persistence + cache pattern as `streamingPref.ts`: one
 * read on first access, one write to flip; the settings KV is the source of
 * truth and main/analytics.ts reads the same key before every event.
 */
import { createRendererLogger } from '../logger'

const log = createRendererLogger('service:analytics-pref')

export const ANALYTICS_ENABLED_SETTING = 'analytics.enabled'
export const ANALYTICS_NOTICE_SEEN_SETTING = 'analytics.noticeSeen'
const DEFAULT_ENABLED = true

let cached: boolean | null = null

export async function isAnalyticsEnabled(): Promise<boolean> {
  if (cached !== null) return cached
  try {
    const raw = await window.api.settings.get(ANALYTICS_ENABLED_SETTING)
    cached = raw === null ? DEFAULT_ENABLED : raw !== 'false'
  } catch (err) {
    log.warn('read failed, assuming default', err)
    cached = DEFAULT_ENABLED
  }
  return cached
}

export async function setAnalyticsEnabled(enabled: boolean): Promise<void> {
  cached = enabled
  try {
    await window.api.settings.set(ANALYTICS_ENABLED_SETTING, enabled ? 'true' : 'false')
  } catch (err) {
    log.warn('write failed', err)
  }
}

/** True when the first-launch notice has not been dismissed yet. */
export async function shouldShowAnalyticsNotice(): Promise<boolean> {
  try {
    return (await window.api.settings.get(ANALYTICS_NOTICE_SEEN_SETTING)) === null
  } catch (err) {
    log.warn('notice flag read failed, hiding notice', err)
    return false
  }
}

export async function markAnalyticsNoticeSeen(): Promise<void> {
  try {
    await window.api.settings.set(ANALYTICS_NOTICE_SEEN_SETTING, 'true')
  } catch (err) {
    log.warn('notice flag write failed', err)
  }
}
