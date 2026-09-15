/**
 * Anonymous usage counts, default on, one click to turn off.
 *
 * What leaves the machine: the event name, a per-install random UUID, the
 * app version, platform, chip and a handful of closed-list properties (see
 * shared/analytics-envelope.ts). Never a hostname, username, path or message.
 *
 * Settings keys (settings table, read on every event so the toggle takes
 * effect at once):
 *   analytics.enabled     'true' | 'false'; unset means true
 *   analytics.installId   UUID minted on first use
 *   analytics.noticeSeen  'true' once the first-launch notice was dismissed
 *
 * No runtime electron import: `configureAnalytics` receives the facts from
 * main/index.ts, so provider-registry (which also runs on the headless
 * server) can import `trackAnalyticsEvent` and stay a no-op there.
 */
import { randomUUID } from 'crypto'
import type { App } from 'electron'
import type { BackendHost } from './backend/host'
import { AnalyticsChannels } from '@shared/ipc-channels'
import {
  ANALYTICS_ENDPOINT,
  RENDERER_ANALYTICS_EVENTS,
  analyticsPlatformFor,
  buildAnalyticsEnvelope,
  isAnalyticsEventName,
  type AnalyticsEnvelope,
  type AnalyticsEnvironment,
  type AnalyticsEventName,
} from '@shared/analytics-envelope'
import { getSetting, setSetting } from './db/database'
import { createMainLogger } from './logger'

const log = createMainLogger('analytics')

export const ANALYTICS_ENABLED_SETTING = 'analytics.enabled'
export const ANALYTICS_INSTALL_ID_SETTING = 'analytics.installId'
export const ANALYTICS_NOTICE_SEEN_SETTING = 'analytics.noticeSeen'

const POST_TIMEOUT_MS = 3_000

interface AnalyticsRuntime {
  environment: AnalyticsEnvironment
  appVersion: string
  arch: string
  translated: boolean
}

let runtime: AnalyticsRuntime | null = null

export function configureAnalytics(facts: AnalyticsRuntime): void {
  runtime = facts
}

export function isAnalyticsEnabled(): boolean {
  return getSetting(ANALYTICS_ENABLED_SETTING) !== 'false'
}

export function analyticsInstallId(): string {
  const existing = getSetting(ANALYTICS_INSTALL_ID_SETTING)
  if (existing) return existing
  const minted = randomUUID()
  setSetting(ANALYTICS_INSTALL_ID_SETTING, minted)
  return minted
}

function postEnvelope(envelope: AnalyticsEnvelope): void {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS)
  fetch(ANALYTICS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
    signal: controller.signal,
  })
    .then((res) => {
      if (!res.ok) log.debug('collector rejected event', { event: envelope.event, status: res.status })
    })
    .catch((err) => log.debug('post failed', { event: envelope.event, err: String(err) }))
    .finally(() => clearTimeout(timer))
}

/** Fire-and-forget. Cannot throw; a failure is a debug line at most. */
export function trackAnalyticsEvent(event: AnalyticsEventName, properties: Record<string, unknown> = {}): void {
  if (!runtime) return
  try {
    const envelope = buildAnalyticsEnvelope(
      {
        enabled: isAnalyticsEnabled(),
        environment: runtime.environment,
        platform: analyticsPlatformFor(process.platform),
        installId: analyticsInstallId(),
      },
      event,
      properties,
    )
    if (envelope) postEnvelope(envelope)
  } catch (err) {
    log.debug('track failed', { event, err: String(err) })
  }
}

/** Once per process, after `app.whenReady`. */
export function trackAppLaunched(): void {
  if (!runtime) return
  trackAnalyticsEvent('app_launched', {
    arch: runtime.arch,
    translated: runtime.translated ? 'true' : 'false',
    app_version: runtime.appVersion,
  })
}

/**
 * Crash counters. Every hook also logs through the main logger; an
 * `uncaughtException` listener here does not replace the EPIPE guard in
 * main/index.ts, it runs beside it.
 */
export function attachAnalyticsCrashHooks(electronApp: App): void {
  electronApp.on('render-process-gone', (_event, _contents, details) => {
    log.error('renderer process gone', { reason: details.reason, exitCode: details.exitCode })
    trackAnalyticsEvent('crash_reported', { kind: 'renderer_gone' })
  })
  electronApp.on('child-process-gone', (_event, details) => {
    // A clean exit of a utility process is lifecycle, not a crash.
    if (details.reason === 'clean-exit') return
    log.error('child process gone', { type: details.type, reason: details.reason, exitCode: details.exitCode, name: details.name })
    trackAnalyticsEvent('crash_reported', { kind: 'child_process_gone' })
  })
  process.on('uncaughtException', (err) => {
    // EPIPE is a closed pipe on a dead child, already tolerated in index.ts.
    if ((err as NodeJS.ErrnoException).code === 'EPIPE') return
    log.error('uncaught exception', err)
    trackAnalyticsEvent('crash_reported', { kind: 'uncaught' })
  })
}

/**
 * Renderer-originated events. Only the tour outcomes are accepted; the
 * renderer cannot mint launch, session or crash counts.
 */
export function registerAnalyticsHandlers(host: BackendHost): void {
  host.handle(AnalyticsChannels.TRACK, (event: unknown, properties?: unknown): boolean => {
    if (!isAnalyticsEventName(event) || !RENDERER_ANALYTICS_EVENTS.has(event)) {
      log.warn('renderer tried to track a non-whitelisted event', { event: String(event) })
      return false
    }
    const props = properties && typeof properties === 'object' && !Array.isArray(properties)
      ? (properties as Record<string, unknown>)
      : {}
    trackAnalyticsEvent(event, props)
    return true
  })
}
