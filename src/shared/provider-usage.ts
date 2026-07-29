/**
 * Provider-agnostic subscription usage limits. Each provider reports quota in
 * its own units, so parsers normalise here: `usedPercent` is always 0-100 and
 * `resetsAtMs` is always epoch ms.
 */

import type { AgentType } from './types'

export type UsageWindowKind = 'session' | 'weekly' | 'monthly' | 'model' | 'other'

export type UsageSeverity = 'ok' | 'warn' | 'critical'

export interface UsageWindow {
  /** Stable key for React lists and test assertions. */
  id: string
  /** Row label as rendered: "5-hour session", "Weekly", "Weekly (Fable)". */
  label: string
  kind: UsageWindowKind
  /** 0-100, clamped. null when the provider names a window but gives no number. */
  usedPercent: number | null
  /** Epoch milliseconds. null when unknown. */
  resetsAtMs: number | null
  /** Nominal window length in minutes (300 / 10080 / 43200). null when unknown. */
  windowMinutes: number | null
  severity: UsageSeverity
  /** Optional secondary text, e.g. a dollar figure. Never a credential. */
  detail?: string
}

/**
 * Paid overage / credits. Deliberately a separate list from `windows`:
 * an account can sit at 100% overage while every real window is still
 * `allowed`, and folding the two together renders that as "cut off".
 */
export interface UsageOverage {
  id: string
  label: string
  enabled: boolean
  /** NOT clamped - values at or above 100 are meaningful here. */
  usedPercent: number | null
  detail?: string
  /** Provider reason string, e.g. `org_spend_cap_reached`. */
  blockedReason?: string | null
}

export type UsageStatus =
  /** At least one window was resolved. */
  | 'ok'
  /** API key / Bedrock / Vertex / gateway / OpenCode - plan limits do not apply. */
  | 'not-applicable'
  /** No readable credential, or a 401 on a credential that had not expired. */
  | 'unauthenticated'
  /** Credential found but its `expiresAt` is in the past. */
  | 'expired'
  /** This backend cannot read the credential store (non-macOS, headless remote). */
  | 'unsupported'
  /** HTTP / RPC / spawn / timeout failure. */
  | 'error'

export interface ProviderUsage {
  instanceId: string
  agentType: AgentType
  status: UsageStatus
  /** "team" | "max" | "go" | "pro" ... null when unknown. */
  plan: string | null
  /** Email or org name. Never a token. */
  account: string | null
  windows: UsageWindow[]
  overage: UsageOverage[]
  /** Present when status !== 'ok'. Actionable prose, never a credential. */
  message?: string
  /** Copyable remediation command, mirroring the existing login-command affordance. */
  command?: string
  /** Snapshot time, epoch ms. Drives the "as of HH:MM" line and the TTL cache. */
  fetchedAtMs: number
}

/**
 * Coerce a provider-supplied percentage without clamping. Deliberately
 * rejects strings rather than coercing them - a provider that starts
 * sending `"12"` is a wire change we want to notice, not paper over.
 */
export function toPercent(value: unknown): number | null {
  if (typeof value !== 'number') return null
  if (!Number.isFinite(value)) return null
  return value
}

/** As `toPercent`, clamped to 0-100 for anything that drives a bar width. */
export function clampPercent(value: unknown): number | null {
  const raw = toPercent(value)
  if (raw === null) return null
  if (raw < 0) return 0
  if (raw > 100) return 100
  return raw
}

/**
 * Severity thresholds are copied from `ContextWindowMeter` (>85 error,
 * >60 warning) so usage colour means the same thing everywhere in the app.
 */
export function severityForPercent(percent: number | null): UsageSeverity {
  if (percent === null) return 'ok'
  if (percent > 85) return 'critical'
  if (percent > 60) return 'warn'
  return 'ok'
}

/** Human label for a rolling-window length. */
export function windowLabelForMinutes(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return 'Usage'
  if (minutes === 300) return '5-hour'
  if (minutes === 10080) return 'Weekly'
  if (minutes === 43200) return '30-day'
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`
  if (minutes % 60 === 0) return `${minutes / 60}-hour`
  return `${minutes}-min`
}

export function kindForMinutes(minutes: number | null): UsageWindowKind {
  if (minutes === null) return 'other'
  if (minutes <= 720) return 'session'
  if (minutes <= 10080) return 'weekly'
  return 'monthly'
}

/**
 * Relative reset time, switching to an absolute date past a week where the
 * relative form stops helping. Not `fmtDuration` from `./format`, which
 * renders sub-second precision that is meaningless for a quota window.
 */
export function fmtResetsIn(resetsAtMs: number | null, nowMs: number): string {
  if (resetsAtMs === null || !Number.isFinite(resetsAtMs)) return 'reset time unknown'
  const deltaMs = resetsAtMs - nowMs
  if (deltaMs <= 0) return 'resetting now'

  const totalMinutes = Math.floor(deltaMs / 60_000)
  if (totalMinutes < 1) return `in ${Math.max(1, Math.floor(deltaMs / 1000))}s`
  if (totalMinutes < 60) return `in ${totalMinutes}m`

  const totalHours = Math.floor(totalMinutes / 60)
  if (totalHours < 24) {
    const minutes = totalMinutes % 60
    return minutes > 0 ? `in ${totalHours}h ${minutes}m` : `in ${totalHours}h`
  }

  const days = Math.floor(totalHours / 24)
  if (days < 7) {
    const hours = totalHours % 24
    return hours > 0 ? `in ${days}d ${hours}h` : `in ${days}d`
  }
  return `resets ${fmtResetsAt(resetsAtMs)}`
}

/** Absolute local timestamp, used for the hover title on every reset value. */
export function fmtResetsAt(resetsAtMs: number | null): string {
  if (resetsAtMs === null || !Number.isFinite(resetsAtMs)) return 'unknown'
  return new Date(resetsAtMs).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Parse an ISO-8601 timestamp to epoch ms, tolerating fractional seconds. */
export function isoToMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/** Codex reports resets in absolute unix SECONDS, not milliseconds. */
export function unixSecondsToMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return Math.round(value * 1000)
}

export function buildWindow(input: {
  id: string
  label: string
  kind: UsageWindowKind
  percent: unknown
  resetsAtMs: number | null
  windowMinutes: number | null
  detail?: string
  forceCritical?: boolean
}): UsageWindow {
  const usedPercent = clampPercent(input.percent)
  return {
    id: input.id,
    label: input.label,
    kind: input.kind,
    usedPercent,
    resetsAtMs: input.resetsAtMs,
    windowMinutes: input.windowMinutes,
    severity: input.forceCritical ? 'critical' : severityForPercent(usedPercent),
    ...(input.detail ? { detail: input.detail } : {}),
  }
}
