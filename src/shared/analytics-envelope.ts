/**
 * Pure envelope builder for the anonymous usage counts the desktop app posts
 * to the tn07 analytics Worker (tn07-site/workers/analytics). No electron
 * import: main/analytics.ts feeds it the runtime facts and owns the transport.
 *
 * The Worker validates every field against a closed list, so the whitelist
 * here mirrors `propertySchemas` there. Anything not listed is dropped before
 * it leaves the machine; the install id is the only identifier that is sent.
 */

import { GENERIC_ACP_AGENTS } from './acp-agents'
import { SECRET_ANSWER_SECONDS_BUCKETS, SECRET_TTLS } from './agent-secret-request'

export type AnalyticsEventName =
  | 'app_launched'
  | 'session_started'
  | 'tour_completed'
  | 'tour_skipped'
  | 'crash_reported'
  | 'secret_request.opened'
  | 'secret_request.extended'
  | 'secret_request.answered'
  | 'secret_request.closed'
  | 'secret_request.refused'
  | 'secret_request.masked'

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

/** Free text with a shape check; mirrors the Worker's `app_version` rule. */
export const APP_VERSION_PATTERN = /^\d+\.\d+\.\d+/
export const APP_VERSION_MAX_LENGTH = 32

/** A closed list of values, or the `app_version` shape check. */
type PropertyRule = ReadonlySet<string> | 'app_version'

const BOOLEAN: ReadonlySet<string> = new Set(['true', 'false'])

/**
 * Each event's properties and the values each may take. A secret request
 * event never carries the secret's name, title, instructions, value, length
 * or a hash of it: only these buckets.
 */
const EVENT_PROPERTIES: Record<AnalyticsEventName, Readonly<Record<string, PropertyRule>>> = {
  app_launched: { arch: new Set(['arm64', 'x64']), translated: BOOLEAN, app_version: 'app_version' },
  session_started: { provider: new Set(['claude', 'codex', 'opencode']) },
  tour_completed: {},
  tour_skipped: {},
  crash_reported: { kind: new Set(['renderer_gone', 'child_process_gone', 'uncaught']) },
  'secret_request.opened': {
    agentKind: new Set(['claude', 'codex', 'opencode', ...GENERIC_ACP_AGENTS]),
    ttlBucket: new Set(SECRET_TTLS),
    remote: BOOLEAN,
  },
  'secret_request.extended': { count: new Set(['1', '2', '3', 'more']) },
  'secret_request.answered': {
    outcome: new Set(['saved', 'declined']),
    secondsBucket: new Set(SECRET_ANSWER_SECONDS_BUCKETS),
  },
  'secret_request.closed': { outcome: new Set(['expired', 'withdrawn', 'archived', 'deleted']) },
  'secret_request.refused': { reason: new Set(['plan', 'child', 'cap', 'invalid']) },
  'secret_request.masked': { where: new Set(['tool', 'text', 'diff']) },
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
  for (const [key, rule] of Object.entries(EVENT_PROPERTIES[event])) {
    const value = properties[key]
    if (typeof value !== 'string') continue
    if (rule === 'app_version') {
      if (value.length <= APP_VERSION_MAX_LENGTH && APP_VERSION_PATTERN.test(value)) out[key] = value
      continue
    }
    if (rule.has(value)) out[key] = value
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
