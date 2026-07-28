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
  type UsageWindow,
} from './provider-usage'

export interface CodexUsageParse {
  ok: boolean
  windows: UsageWindow[]
  overage: UsageOverage[]
  plan: string | null
  /** Every snapshot field was null - "unknown yet", distinct from an error. */
  allNull: boolean
  error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function empty(overrides: Partial<CodexUsageParse> = {}): CodexUsageParse {
  return { ok: true, windows: [], overage: [], plan: null, allNull: false, ...overrides }
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
  forceCritical: boolean,
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
    forceCritical,
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
  const primary = readWindow(snapshot.primary, `${key}_primary`, labelPrefix, windowReached)
  if (primary) windows.push(primary)
  const secondary = readWindow(snapshot.secondary, `${key}_secondary`, labelPrefix, windowReached)
  if (secondary) windows.push(secondary)

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

  if (resetCredits) {
    const count = typeof resetCredits.availableCount === 'number'
      ? resetCredits.availableCount
      : typeof resetCredits.availableCount === 'bigint'
        ? Number(resetCredits.availableCount)
        : null
    if (count !== null && count > 0) {
      overage.push({
        id: 'reset_credits',
        label: 'Reset credits',
        enabled: true,
        usedPercent: null,
        detail: `${count} available`,
        blockedReason: null,
      })
    }
  }

  // "Nothing to show" is what the caller acts on, so base it on the rows
  // actually produced. A present-but-empty rateLimitsByLimitId used to fall
  // through as ok-with-no-rows, rendering a header and nothing else.
  return { ok: true, windows, overage, plan, allNull: windows.length === 0 && overage.length === 0 }
}
