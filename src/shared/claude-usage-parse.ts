/**
 * Parser for Anthropic's `GET /api/oauth/usage` response.
 *
 * Shape traps: `utilization` is 0-100 here (the /v1/messages headers report
 * 0-1), `seven_day_opus`/`seven_day_sonnet` are legacy and null so the
 * per-model weekly limit comes from `limits[]` as `kind: "weekly_scoped"`,
 * and `is_active` marks which limit is currently *binding* rather than
 * whether it exists - the per-model row is routinely false.
 */

import {
  buildWindow,
  isoToMs,
  toPercent,
  type UsageOverage,
  type UsageWindow,
} from './provider-usage'

/**
 * Keys that prove the body is a usage payload rather than an error page or
 * an empty object. Mirrors the sentinel the Claude CLI applies before
 * trusting the response.
 */
const SENTINEL_KEYS = [
  'five_hour',
  'seven_day',
  'seven_day_oauth_apps',
  'seven_day_opus',
  'seven_day_sonnet',
  'cinder_cove',
  'extra_usage',
  'limits',
] as const

export interface ClaudeUsageParse {
  ok: boolean
  windows: UsageWindow[]
  overage: UsageOverage[]
  error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface Bucket {
  percent: unknown
  resetsAtMs: number | null
  detail?: string
}

/** A `{utilization, resets_at, ...}` bucket. */
function readBucket(value: unknown): Bucket | null {
  if (!isRecord(value)) return null
  const detail = dollarsDetail(value.used_dollars, value.limit_dollars)
  return {
    percent: value.utilization,
    resetsAtMs: isoToMs(value.resets_at),
    ...(detail ? { detail } : {}),
  }
}

function dollarsDetail(used: unknown, limit: unknown): string | undefined {
  if (typeof used !== 'number' || typeof limit !== 'number') return undefined
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return undefined
  return `$${used.toFixed(2)} of $${limit.toFixed(2)}`
}

/** `{amount_minor, currency, exponent}` to a display string. */
function readMoney(value: unknown): string | null {
  if (!isRecord(value)) return null
  const minor = value.amount_minor
  if (typeof minor !== 'number' || !Number.isFinite(minor)) return null
  // Clamped because toFixed throws a RangeError outside 0-100, and `exponent`
  // comes straight off the wire.
  const rawExponent = typeof value.exponent === 'number' && Number.isFinite(value.exponent)
    ? Math.trunc(value.exponent)
    : 0
  const exponent = Math.min(20, Math.max(0, rawExponent))
  const currency = typeof value.currency === 'string' ? value.currency : ''
  const amount = minor / 10 ** exponent
  const symbol = currency === 'USD' ? '$' : currency ? `${currency} ` : ''
  return `${symbol}${amount.toFixed(exponent)}`
}

function scopedLabel(scope: unknown): string {
  if (isRecord(scope) && isRecord(scope.model) && typeof scope.model.display_name === 'string') {
    const name = scope.model.display_name.trim()
    if (name) return `Weekly (${name})`
  }
  return 'Weekly (scoped)'
}

function readLimitsArray(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return []
  return raw.filter(isRecord)
}

export function parseClaudeUsage(raw: unknown): ClaudeUsageParse {
  if (!isRecord(raw)) {
    return { ok: false, windows: [], overage: [], error: 'usage response was not an object' }
  }
  const hasSentinel = SENTINEL_KEYS.some((key) => key in raw)
  if (!hasSentinel) {
    return { ok: false, windows: [], overage: [], error: 'usage response did not contain any known limit fields' }
  }

  const windows: UsageWindow[] = []
  const limits = readLimitsArray(raw.limits)

  // Session window. `five_hour` is authoritative; the `limits[]` entry with
  // kind "session" is the same number and is only a fallback.
  const fiveHour = readBucket(raw.five_hour)
    ?? bucketFromLimit(limits.find((l) => l.kind === 'session'))
  if (fiveHour) {
    windows.push(buildWindow({
      id: 'five_hour',
      label: '5-hour session',
      kind: 'session',
      percent: fiveHour.percent,
      resetsAtMs: fiveHour.resetsAtMs,
      windowMinutes: 300,
      ...(fiveHour.detail ? { detail: fiveHour.detail } : {}),
    }))
  }

  const sevenDay = readBucket(raw.seven_day)
    ?? bucketFromLimit(limits.find((l) => l.kind === 'weekly_all'))
  if (sevenDay) {
    windows.push(buildWindow({
      id: 'seven_day',
      label: 'Weekly',
      kind: 'weekly',
      percent: sevenDay.percent,
      resetsAtMs: sevenDay.resetsAtMs,
      windowMinutes: 10080,
      ...(sevenDay.detail ? { detail: sevenDay.detail } : {}),
    }))
  }

  // Per-model weekly limits. This is where the top-tier-model row lives on
  // current accounts; `seven_day_opus` / `seven_day_sonnet` are dead.
  limits
    .filter((l) => l.kind === 'weekly_scoped')
    .forEach((entry, index) => {
      windows.push(buildWindow({
        id: `weekly_scoped_${index}`,
        label: scopedLabel(entry.scope),
        kind: 'model',
        percent: entry.percent,
        resetsAtMs: isoToMs(entry.resets_at),
        windowMinutes: 10080,
      }))
    })

  return { ok: true, windows, overage: readOverage(raw) }
}

function bucketFromLimit(entry: Record<string, unknown> | undefined): Bucket | null {
  if (!entry) return null
  return { percent: entry.percent, resetsAtMs: isoToMs(entry.resets_at) }
}

function readOverage(raw: Record<string, unknown>): UsageOverage[] {
  const extra = raw.extra_usage
  const spend = raw.spend
  if (!isRecord(extra) && !isRecord(spend)) return []

  const enabled = isRecord(extra)
    ? extra.is_enabled === true
    : isRecord(spend) && spend.enabled === true

  const percent = isRecord(extra)
    ? toPercent(extra.utilization)
    : isRecord(spend)
      ? toPercent(spend.percent)
      : null

  const detail = spendDetail(extra, spend)

  // An empty or all-null overage object carries no information; emitting a row
  // for it would render a bare "Extra usage / off" line and mask the
  // "no plan limits reported" case upstream.
  if (!enabled && percent === null && !detail) return []

  const blockedReason = isRecord(extra) && typeof extra.disabled_reason === 'string'
    ? extra.disabled_reason
    : null

  return [{
    id: 'extra_usage',
    label: 'Extra usage',
    enabled,
    usedPercent: percent,
    ...(detail ? { detail } : {}),
    blockedReason,
  }]
}

function spendDetail(extra: unknown, spend: unknown): string | undefined {
  if (isRecord(spend)) {
    const used = readMoney(spend.used)
    const limit = readMoney(spend.limit)
    if (used && limit) return `${used} of ${limit}`
    if (used) return used
  }
  if (isRecord(extra)) {
    const used = extra.used_credits
    const limit = extra.monthly_limit
    if (typeof used === 'number' && typeof limit === 'number') {
      return `${used.toFixed(0)} of ${limit.toFixed(0)} credits`
    }
  }
  return undefined
}
