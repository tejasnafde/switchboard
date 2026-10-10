/**
 * Parser for the Codex app-server JSON-RPC `account/rateLimits/read` result.
 *
 * Wire traps: fields are camelCase here (`codex exec --json` uses snake_case
 * for the same data, which would read as undefined), `resetsAt` is unix
 * SECONDS, `secondary` is genuinely optional, and only `usedPercent` is
 * required on a window. A cold server can answer all-null before its
 * snapshot is populated, so `allNull` is reported separately from an error.
 */

import {
  buildWindow,
  kindForMinutes,
  toPercent,
  unixSecondsToMs,
  windowLabelForMinutes,
  type UsageOverage,
  type UsageResetCredit,
  type UsageResetCredits,
  type UsageWindow,
} from './provider-usage'

export interface CodexUsageParse {
  ok: boolean
  windows: UsageWindow[]
  overage: UsageOverage[]
  plan: string | null
  /** Banked rate-limit resets, null when the response carries none. */
  resetCredits: UsageResetCredits | null
  /** Every snapshot field was null - "unknown yet", distinct from an error. */
  allNull: boolean
  error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function empty(overrides: Partial<CodexUsageParse> = {}): CodexUsageParse {
  return { ok: true, windows: [], overage: [], plan: null, resetCredits: null, allNull: false, ...overrides }
}

/** Detects the wrong protocol dialect (see the header note). */
function looksSnakeCase(snapshot: Record<string, unknown>): boolean {
  for (const key of ['primary', 'secondary'] as const) {
    const win = snapshot[key]
    if (isRecord(win) && !('usedPercent' in win) && 'used_percent' in win) return true
  }
  return false
}

function readWindow(
  raw: unknown,
  id: string,
  labelPrefix: string,
): UsageWindow | null {
  if (!isRecord(raw)) return null
  const percent = toPercent(raw.usedPercent)
  if (percent === null) return null
  const minutes = typeof raw.windowDurationMins === 'number' && Number.isFinite(raw.windowDurationMins)
    ? raw.windowDurationMins
    : null
  const base = windowLabelForMinutes(minutes)
  return buildWindow({
    id,
    label: labelPrefix ? `${base} (${labelPrefix})` : base,
    kind: kindForMinutes(minutes),
    percent,
    resetsAtMs: unixSecondsToMs(raw.resetsAt),
    windowMinutes: minutes,
  })
}

function readSnapshot(
  snapshot: Record<string, unknown>,
  key: string,
  labelPrefix: string,
): { windows: UsageWindow[]; overage: UsageOverage[]; plan: string | null } {
  const reached = typeof snapshot.rateLimitReachedType === 'string' ? snapshot.rateLimitReachedType : null
  // Credit-depletion reasons describe the overage balance, not a rolling
  // window, so they must not turn a healthy window red.
  const windowReached = reached !== null && !reached.toLowerCase().includes('credits_depleted')

  const windows: UsageWindow[] = []
  const primary = readWindow(snapshot.primary, `${key}_primary`, labelPrefix)
  if (primary) windows.push(primary)
  const secondary = readWindow(snapshot.secondary, `${key}_secondary`, labelPrefix)
  if (secondary) windows.push(secondary)
  // The reached flag is per account and does not name the window. Redden the
  // window that is full (or the fullest one), not every window: a weekly
  // window at 16% must not turn red because the 5-hour window hit 100%.
  if (windowReached && windows.length > 0) {
    const full = windows.filter((w) => (w.usedPercent ?? 0) >= 100)
    const hit = full.length > 0
      ? full
      : [windows.reduce((a, b) => ((b.usedPercent ?? 0) > (a.usedPercent ?? 0) ? b : a))]
    for (const w of hit) {
      w.severity = 'critical'
      w.reached = true
    }
  }

  // A spend control is a hard cap rather than a rolling window, but it
  // consumes the same visual row.
  const individual = snapshot.individualLimit
  if (isRecord(individual)) {
    const remaining = toPercent(individual.remainingPercent)
    if (remaining !== null) {
      windows.push(buildWindow({
        id: `${key}_individual`,
        label: labelPrefix ? `Spend limit (${labelPrefix})` : 'Spend limit',
        kind: 'other',
        percent: 100 - remaining,
        resetsAtMs: unixSecondsToMs(individual.resetsAt),
        windowMinutes: null,
        ...(typeof individual.used === 'string' && typeof individual.limit === 'string'
          ? { detail: `${individual.used} of ${individual.limit}` }
          : {}),
      }))
    }
  }

  const overage: UsageOverage[] = []
  const credits = snapshot.credits
  if (isRecord(credits) && (credits.hasCredits === true || credits.unlimited === true)) {
    overage.push({
      id: `${key}_credits`,
      label: 'Credits',
      enabled: true,
      usedPercent: null,
      detail: credits.unlimited === true
        ? 'Unlimited'
        : credits.balance !== null && credits.balance !== undefined
          ? `${String(credits.balance)} available`
          : 'Available',
      blockedReason: null,
    })
  }

  const plan = typeof snapshot.planType === 'string' ? snapshot.planType : null
  return { windows, overage, plan }
}

const CREDIT_STATUSES: ReadonlySet<UsageResetCredit['status']> = new Set(['available', 'redeeming', 'redeemed'])

function readCount(value: unknown): number | null {
  const n = typeof value === 'bigint' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  return Math.max(0, Math.floor(n))
}

/**
 * `rateLimitResetCredits { availableCount, credits[] | null }`. The list is
 * optional on the wire: null means only the count is known. A credit without
 * a string id is dropped, since it could not be named in a consume call.
 */
function readResetCredits(raw: Record<string, unknown>): UsageResetCredits | null {
  const availableCount = readCount(raw.availableCount)
  if (availableCount === null) return null
  if (!Array.isArray(raw.credits)) return { availableCount, credits: null }
  const credits: UsageResetCredit[] = []
  for (const entry of raw.credits) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0) continue
    const status = typeof entry.status === 'string' && CREDIT_STATUSES.has(entry.status as UsageResetCredit['status'])
      ? entry.status as UsageResetCredit['status']
      : 'unknown'
    credits.push({
      id: entry.id,
      expiresAtMs: unixSecondsToMs(entry.expiresAt),
      status,
      title: typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : null,
    })
  }
  return { availableCount, credits }
}

export function parseCodexRateLimits(raw: unknown): CodexUsageParse {
  if (!isRecord(raw)) {
    return { ...empty(), ok: false, error: 'rate-limit response was not an object' }
  }

  const byId = isRecord(raw.rateLimitsByLimitId) ? raw.rateLimitsByLimitId : null
  const single = isRecord(raw.rateLimits) ? raw.rateLimits : null
  const resetCredits = isRecord(raw.rateLimitResetCredits) ? raw.rateLimitResetCredits : null
  // `dailyUsageBuckets` is present on this response and deliberately ignored:
  // it is historical spend, not quota.

  // `rateLimits` is documented as a backward-compatible view of one entry in
  // `rateLimitsByLimitId`, so prefer the keyed map and never render both.
  const entries: Array<[string, Record<string, unknown>]> = []
  if (byId) {
    for (const [key, value] of Object.entries(byId)) {
      if (isRecord(value)) entries.push([key, value])
    }
  }
  if (entries.length === 0 && single) entries.push(['default', single])

  if (entries.some(([, snapshot]) => looksSnakeCase(snapshot))) {
    return {
      ...empty(),
      ok: false,
      error: 'rate-limit response used snake_case fields (wrong Codex protocol dialect)',
    }
  }

  const windows: UsageWindow[] = []
  const overage: UsageOverage[] = []
  let plan: string | null = null
  const multiple = entries.length > 1

  for (const [key, snapshot] of entries) {
    const limitName = typeof snapshot.limitName === 'string' && snapshot.limitName.trim()
      ? snapshot.limitName.trim()
      : typeof snapshot.limitId === 'string' && snapshot.limitId.trim()
        ? snapshot.limitId.trim()
        : key
    const parsed = readSnapshot(snapshot, key, multiple ? limitName : '')
    windows.push(...parsed.windows)
    overage.push(...parsed.overage)
    if (!plan && parsed.plan) plan = parsed.plan
  }

  const resets = resetCredits ? readResetCredits(resetCredits) : null

  // "Nothing to show" is what the caller acts on, so base it on the rows
  // actually produced. A present-but-empty rateLimitsByLimitId used to fall
  // through as ok-with-no-rows, rendering a header and nothing else.
  return {
    ok: true,
    windows,
    overage,
    plan,
    resetCredits: resets,
    allNull: windows.length === 0 && overage.length === 0 && (resets?.availableCount ?? 0) === 0,
  }
}
