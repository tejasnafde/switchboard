/**
 * Pure envelope builder for the anonymous usage counts the desktop app posts
 * to the tn07 analytics Worker (tn07-site/workers/analytics). No electron
 * import: main/analytics.ts feeds it the runtime facts and owns the transport.
 *
 * The Worker validates every field against a closed list, so the whitelist
 * here mirrors `propertySchemas` there. Anything not listed is dropped before
 * it leaves the machine; the install id is the only identifier that is sent.
 */

export type AnalyticsEventName =
  | 'app_launched'
  | 'session_started'
  | 'tour_completed'
  | 'tour_skipped'
  | 'crash_reported'

/** Event names the renderer may report through `AnalyticsChannels.TRACK`. */
export const RENDERER_ANALYTICS_EVENTS: ReadonlySet<string> = new Set<AnalyticsEventName>([
  'tour_completed',
  'tour_skipped',
])

export const ANALYTICS_ENDPOINT = 'https://analytics.tn07.dev/v1/events'
export const ANALYTICS_PRODUCT = 'switchboard'
export const ANALYTICS_SURFACE = 'desktop'

export type AnalyticsPlatform = 'macos' | 'windows'
export type AnalyticsEnvironment = 'production' | 'development'

const ENUM_PROPERTIES: Record<string, ReadonlySet<string>> = {
  arch: new Set(['arm64', 'x64']),
  translated: new Set(['true', 'false']),
  provider: new Set(['claude', 'codex', 'opencode']),
  kind: new Set(['renderer_gone', 'child_process_gone', 'uncaught']),
}

/** Free text with a shape check; mirrors the Worker's `app_version` rule. */
export const APP_VERSION_PATTERN = /^\d+\.\d+\.\d+/
export const APP_VERSION_MAX_LENGTH = 32

const EVENT_PROPERTIES: Record<AnalyticsEventName, readonly string[]> = {
  app_launched: ['arch', 'translated', 'app_version'],
  session_started: ['provider'],
  tour_completed: [],
  tour_skipped: [],
  crash_reported: ['kind'],
}

export interface AnalyticsContext {
  enabled: boolean
  environment: AnalyticsEnvironment
  /** null on platforms the Worker does not list (linux). */
  platform: AnalyticsPlatform | null
  installId: string
}

export interface AnalyticsEnvelope {
  event: AnalyticsEventName
  event_version: 1
  product: typeof ANALYTICS_PRODUCT
  surface: typeof ANALYTICS_SURFACE
  environment: 'production'
  authority: 'client'
  platform: AnalyticsPlatform
  install_id: string
  properties: Record<string, string>
}

export function isAnalyticsEventName(value: unknown): value is AnalyticsEventName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(EVENT_PROPERTIES, value)
}

export function analyticsPlatformFor(processPlatform: string): AnalyticsPlatform | null {
  if (processPlatform === 'darwin') return 'macos'
  if (processPlatform === 'win32') return 'windows'
  return null
}

/** Keep only the properties the event declares, with values the Worker accepts. */
export function whitelistAnalyticsProperties(
  event: AnalyticsEventName,
  properties: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of EVENT_PROPERTIES[event]) {
    const value = properties[key]
    if (typeof value !== 'string') continue
    if (key === 'app_version') {
      if (value.length <= APP_VERSION_MAX_LENGTH && APP_VERSION_PATTERN.test(value)) out[key] = value
      continue
    }
    if (ENUM_PROPERTIES[key]?.has(value)) out[key] = value
  }
  return out
}

/**
 * Returns null when nothing must be sent: analytics disabled, not a
 * production build, or a platform the Worker does not accept.
 */
export function buildAnalyticsEnvelope(
  ctx: AnalyticsContext,
  event: AnalyticsEventName,
  properties: Record<string, unknown> = {},
): AnalyticsEnvelope | null {
  if (!ctx.enabled) return null
  if (ctx.environment !== 'production') return null
  if (!ctx.platform) return null
  return {
    event,
    event_version: 1,
    product: ANALYTICS_PRODUCT,
    surface: ANALYTICS_SURFACE,
    environment: 'production',
    authority: 'client',
    platform: ctx.platform,
    install_id: ctx.installId,
    properties: whitelistAnalyticsProperties(event, properties),
  }
}
