/**
 * What the Accounts & models page shows, as pure functions: the order of the
 * cards, the summary strip, the bar colours and the reset countdowns.
 */
import { defaultInstanceId, type AgentType, type ProviderInstance } from '@shared/types'
import { resolveMachineInstanceId } from '@shared/session-defaults'
import { severityForPercent, type ProviderUsage, type UsageWindow } from '@shared/provider-usage'
import { credentialHomeDisplay } from '../../shared/provider-instance-display'

export type BarTone = 'ok' | 'warn' | 'bad'

/** Amber from 75%, red from 90%, and red whenever the provider says the window is reached. */
export function barTone({ usedPercent: percent, severity }: Pick<UsageWindow, 'usedPercent' | 'severity'>): BarTone {
  if (severity === 'critical' && severityForPercent(percent) !== 'critical') return 'bad'
  if (percent !== null && percent >= 90) return 'bad'
  if (percent !== null && percent >= 75) return 'warn'
  return 'ok'
}

/** Signed out, or its usage could not be read at all. */
export function needsAttention(usage: ProviderUsage | undefined): boolean {
  return usage?.status === 'unauthenticated' || usage?.status === 'error'
}

function numbered(usage: ProviderUsage | undefined): (UsageWindow & { usedPercent: number })[] {
  if (usage?.status !== 'ok') return []
  return usage.windows.filter((w): w is UsageWindow & { usedPercent: number } => w.usedPercent !== null)
}

/** 100 minus the fullest window, or null when nothing was reported. */
export function roomLeft(usage: ProviderUsage | undefined): number | null {
  const windows = numbered(usage)
  if (windows.length === 0) return null
  return 100 - Math.max(...windows.map((w) => w.usedPercent))
}

/** Most room first, then accounts with no numbers, then the ones needing attention. */
export function sortByRoomLeft(
  instances: readonly ProviderInstance[],
  usages: Readonly<Record<string, ProviderUsage>>,
): ProviderInstance[] {
  const rank = (inst: ProviderInstance) => {
    const usage = usages[inst.id]
    if (needsAttention(usage)) return -2
    return roomLeft(usage) ?? -1
  }
  return [...instances].sort((a, b) => rank(b) - rank(a))
}

/**
 * The card order while the page stays open: accounts already shown keep their
 * place, whatever their usage says now, and only accounts new to the page are
 * sorted (by the readings at hand) and appended. Re-sorting as each reading
 * landed made the cards jump; the page sorts afresh the next time it opens.
 */
export function stableOrder(
  shown: readonly string[],
  instances: readonly ProviderInstance[],
  usages: Readonly<Record<string, ProviderUsage>>,
): ProviderInstance[] {
  const byId = new Map(instances.map((i) => [i.id, i]))
  const kept = shown.flatMap((id) => byId.get(id) ?? [])
  const keptIds = new Set(kept.map((i) => i.id))
  return [...kept, ...sortByRoomLeft(instances.filter((i) => !keptIds.has(i.id)), usages)]
}

/** "in 2 h 14 min" under a day, the date after that. */
export function untilReset(resetsAtMs: number | null, nowMs: number): string {
  if (resetsAtMs === null) return ''
  const minutes = Math.ceil((resetsAtMs - nowMs) / 60_000)
  if (minutes <= 0) return 'now'
  if (minutes < 60) return `in ${minutes} min`
  if (minutes < 24 * 60) return `in ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
  return new Date(resetsAtMs).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}

export function windowSummary(usage: ProviderUsage | undefined): string {
  return numbered(usage).map((w) => `${w.label} ${Math.round(w.usedPercent)}%`).join(', ')
}

export interface SummaryCell {
  value: string
  detail: string
}

export interface AccountsSummary {
  mostRoom: SummaryCell
  nextReset: SummaryCell
  attention: SummaryCell & { count: number }
}

export function accountsSummary(
  instances: readonly ProviderInstance[],
  usages: Readonly<Record<string, ProviderUsage>>,
  nowMs: number,
  listed = true,
): AccountsSummary {
  // Before the account list or an account's first reading lands, an empty
  // tile means "not yet", not "nothing to report".
  const reading = !listed || instances.some((inst) => !usages[inst.id])
  const pending = { value: '-', detail: 'Reading usage…' }
  const best = sortByRoomLeft(instances, usages)[0]
  const mostRoom = best && roomLeft(usages[best.id]) !== null
    ? { value: best.displayName, detail: windowSummary(usages[best.id]) }
    : reading ? pending : { value: '-', detail: 'No usage reported yet' }

  let soonest: { at: number; name: string; label: string } | null = null
  for (const inst of instances) {
    for (const w of numbered(usages[inst.id])) {
      if (w.resetsAtMs !== null && w.resetsAtMs > nowMs && (!soonest || w.resetsAtMs < soonest.at)) {
        soonest = { at: w.resetsAtMs, name: inst.displayName, label: w.label }
      }
    }
  }
  const nextReset = soonest
    ? { value: untilReset(soonest.at, nowMs), detail: `${soonest.name}, ${soonest.label}` }
    : reading ? pending : { value: '-', detail: 'No reset times reported' }

  const flagged = instances.filter((inst) => needsAttention(usages[inst.id]))
  const count = flagged.length
  const attention = count === 0 && reading ? { count, ...pending } : {
    count,
    value: count === 0 ? 'None' : `${count} account${count === 1 ? '' : 's'}`,
    detail: count === 0
      ? 'Every account is readable'
      : flagged.map((inst) => `${inst.displayName} ${usages[inst.id]?.status === 'error' ? 'could not be read' : 'is signed out'}`).join(', '),
  }
  return { mostRoom, nextReset, attention }
}

/** Where the account's credentials come from, for the card's muted line. */
export function credentialSummary(inst: ProviderInstance): string {
  if (inst.authMode === 'env' && inst.envKeys.length > 0) return `API key (${inst.envKeys.join(', ')})`
  if (inst.agentType === 'opencode') return 'Shell environment'
  return credentialHomeDisplay(inst.effectiveOauthDir, inst.effectiveOauthDirSource).text
}

/**
 * The account a new chat of this kind starts on: the machine default the
 * composer writes, while it still names one of these accounts, else the
 * structural `<kind>-default` row the backend falls back to.
 */
export function defaultAccountId(
  kind: AgentType,
  instances: readonly ProviderInstance[],
  stored: { scoped?: string; legacy?: string },
): string {
  const owner = (id: string | undefined) => instances.find((i) => i.id === id)?.agentType ?? null
  const id = resolveMachineInstanceId({ agentType: kind, scoped: stored.scoped, legacy: stored.legacy, legacyAgentType: owner(stored.legacy) })
  return id && owner(id) === kind ? id : defaultInstanceId(kind)
}

/** Reads each key on its own, so one failed read keeps the rest. */
export async function readSettings(
  keys: readonly string[],
  get: (key: string) => Promise<string | null>,
): Promise<{ values: Record<string, string>; failed: { key: string; reason: unknown }[] }> {
  const results = await Promise.allSettled(keys.map((key) => get(key)))
  const values: Record<string, string> = {}
  const failed: { key: string; reason: unknown }[] = []
  results.forEach((result, i) => {
    if (result.status === 'rejected') failed.push({ key: keys[i], reason: result.reason })
    else if (result.value) values[keys[i]] = result.value
  })
  return { values, failed }
}
