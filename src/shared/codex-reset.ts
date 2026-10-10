/**
 * Spending a banked Codex rate-limit reset from Settings > Accounts: when the
 * card offers one, what the confirm and the result say, and how the
 * `account/rateLimitResetCredit/consume` answer maps to a result.
 *
 * Pure, so the renderer, the main process and the tests share one copy.
 */

import { fmtResetsIn, type ProviderUsage, type UsageResetCredit, type UsageWindow } from './provider-usage'

/**
 * `reset` and `alreadyRedeemed` both mean a reset was applied (the second on a
 * retry with the same idempotency key). `unknown` means no answer was read: a
 * timeout, a dropped app-server or a reply we cannot parse.
 */
export type CodexResetOutcome = 'reset' | 'alreadyRedeemed' | 'nothingToReset' | 'noCredit' | 'unknown'

export interface CodexResetResult {
  outcome: CodexResetOutcome
  /** The reading taken after the outcome, so the card shows what Codex reports now. */
  usage: ProviderUsage
}

const WIRE_OUTCOMES: ReadonlySet<string> = new Set(['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'])

export function parseConsumeOutcome(result: unknown): CodexResetOutcome {
  if (typeof result !== 'object' || result === null) return 'unknown'
  const outcome = (result as Record<string, unknown>).outcome
  return typeof outcome === 'string' && WIRE_OUTCOMES.has(outcome) ? outcome as CodexResetOutcome : 'unknown'
}

/** Every outcome but `unknown` is terminal: the idempotency key is dropped. */
export function isTerminalOutcome(outcome: CodexResetOutcome): boolean {
  return outcome !== 'unknown'
}

/** Above 85% (`critical`) or flagged reached by Codex. */
function isCritical(w: UsageWindow): boolean {
  return w.severity === 'critical' || w.reached === true
}

/** At 100% or flagged reached: the stricter rule after a `nothingToReset`. */
function isAtLimit(w: UsageWindow): boolean {
  return w.reached === true || (w.usedPercent ?? 0) >= 100
}

/**
 * Show "Use reset" only when a reset can help: a window is critical and a
 * reset is banked. After Codex answered `nothingToReset`, our 85% rule was
 * looser than its own, so the button waits for a window at its limit.
 */
export function canOfferReset(usage: ProviderUsage | undefined, afterNothingToReset = false): boolean {
  if (usage?.status !== 'ok' || usage.agentType !== 'codex') return false
  if ((usage.resetCredits?.availableCount ?? 0) <= 0) return false
  return usage.windows.some(afterNothingToReset ? isAtLimit : isCritical)
}

/** Available credits, soonest expiry first; a credit with no expiry goes last. */
export function spendableCredits(usage: ProviderUsage | undefined): UsageResetCredit[] {
  const credits = usage?.resetCredits?.credits ?? []
  return credits
    .filter((c) => c.status === 'available')
    .sort((a, b) => (a.expiresAtMs ?? Infinity) - (b.expiresAtMs ?? Infinity))
}

/** The credit the consume call names: the soonest to expire, when the list is known. */
export function soonestCreditId(usage: ProviderUsage | undefined): string | null {
  return spendableCredits(usage)[0]?.id ?? null
}

/** "Oct 30". Pinned to en-US so the card reads the same on every machine. */
export function fmtExpiryDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** The muted part of the "Resets available" line: "next expires Oct 30", or null. */
export function resetsExpiryNote(usage: ProviderUsage | undefined): string | null {
  const dated = spendableCredits(usage).filter((c) => c.expiresAtMs !== null)
  const first = dated[0]
  if (!first || first.expiresAtMs === null) return null
  const date = fmtExpiryDate(first.expiresAtMs)
  return (usage?.resetCredits?.availableCount ?? 0) > 1 ? `next expires ${date}` : `expires ${date}`
}

/** One line per known credit, for the count's hover text. */
export function resetCreditLines(usage: ProviderUsage | undefined): string[] {
  return spendableCredits(usage).map((c) => {
    const title = c.title ?? 'Reset'
    return c.expiresAtMs === null ? title : `${title} · expires ${fmtExpiryDate(c.expiresAtMs)}`
  })
}

export interface ResetConfirmRow {
  key: string
  value: string
}

export function resetConfirmRows(usage: ProviderUsage | undefined): ResetConfirmRow[] {
  const count = usage?.resetCredits?.availableCount ?? 0
  const rows: ResetConfirmRow[] = [
    { key: 'Clears', value: 'Codex usage limits' },
    { key: 'Remaining', value: String(Math.max(0, count - 1)) },
  ]
  const first = spendableCredits(usage)[0]
  if (first?.expiresAtMs != null) rows.push({ key: 'Uses', value: `The reset expiring ${fmtExpiryDate(first.expiresAtMs)}` })
  return rows
}

export type ResetBannerTone = 'good' | 'info' | 'bad'

export interface ResetBanner {
  tone: ResetBannerTone
  text: string
  /** `unknown` offers "Try again" (same key) instead of a dismiss. */
  retry: boolean
}

/** "5-hour" stays, "Weekly" reads "weekly" inside a sentence. */
function sentenceLabel(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1)
}

/** The critical window that frees up first, for the `noCredit` sentence. */
function soonestCriticalWindow(usage: ProviderUsage, nowMs: number): UsageWindow | null {
  let best: UsageWindow | null = null
  for (const w of usage.windows) {
    if (!isCritical(w) || w.resetsAtMs === null || w.resetsAtMs <= nowMs) continue
    if (!best || w.resetsAtMs < (best.resetsAtMs ?? Infinity)) best = w
  }
  return best
}

export function resetResultBanner(outcome: CodexResetOutcome, usage: ProviderUsage, nowMs: number): ResetBanner {
  switch (outcome) {
    case 'reset': {
      const left = usage.resetCredits?.availableCount ?? 0
      return { tone: 'good', retry: false, text: `Limits reset. ${left} reset${left === 1 ? '' : 's'} remaining.` }
    }
    case 'alreadyRedeemed':
      return { tone: 'good', retry: false, text: 'This reset was already applied. No additional reset was used.' }
    case 'nothingToReset':
      return { tone: 'info', retry: false, text: 'No limit is eligible for a reset yet. Nothing was used.' }
    case 'noCredit': {
      const w = soonestCriticalWindow(usage, nowMs)
      // fmtResetsIn answers "in 3h 52m", or "resets Oct 30" past a week.
      const when = w ? fmtResetsIn(w.resetsAtMs, nowMs) : ''
      const phrase = when.startsWith('in ') ? `resets ${when}` : when.startsWith('resets ') ? when : null
      return {
        tone: 'bad',
        retry: false,
        text: w && phrase ? `No resets available. The ${sentenceLabel(w.label)} limit ${phrase}.` : 'No resets available.',
      }
    }
    case 'unknown':
      return {
        tone: 'bad',
        retry: true,
        text: 'Codex did not respond, so the result is unknown. Retrying will not use a second reset.',
      }
  }
}
