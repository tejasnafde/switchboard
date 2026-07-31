/**
 * User-facing copy for a Claude Code `rate_limit_event` rejection. Pure so the
 * branching is unit-testable. See docs/notes/rate-limit-debugging.md.
 */

import { fmtResetsAt, fmtResetsIn, unixSecondsToMs } from './provider-usage'

/** Mirrors the fields we read off `SDKRateLimitInfo` (sdk.d.ts). */
export interface ClaudeRateLimitInfo {
  status?: string
  rateLimitType?: string
  /** Unix SECONDS, not milliseconds. */
  resetsAt?: number
  utilization?: number
  overageStatus?: string
  overageDisabledReason?: string
  isUsingOverage?: boolean
}

/** Whether switching credentials can help. */
export type OverageScope =
  /** Org, group or seat-tier wide, so sibling instances are blocked too. */
  | 'org'
  /** This member's credits specifically; another account may work. */
  | 'account'
  /** Extra usage was never set up, so there is nothing to exhaust. */
  | 'not-provisioned'
  /** No reason reported, or a value newer than this table. */
  | 'unknown'

/**
 * Values from `SDKRateLimitInfo.overageDisabledReason` (sdk.d.ts). Enumerated
 * because guessing got it wrong: there is no `user_*` or `spend_limit_*` value
 * on this wire, so prefix-only matching left five real values classified as
 * "no reason reported" and advising a retry for a permanent admin toggle.
 */
const ORG_REASONS = new Set([
  'org_level_disabled',
  'org_level_disabled_until',
  'org_service_level_disabled',
  'org_service_zero_credit_limit',
  'seat_tier_level_disabled',
  'seat_tier_zero_credit_limit',
  'group_zero_credit_limit',
])
const ACCOUNT_REASONS = new Set([
  'out_of_credits',
  'member_level_disabled',
  'member_zero_credit_limit',
])
const NOT_PROVISIONED_REASONS = new Set(['overage_not_provisioned', 'no_limits_configured'])

export function classifyOverageScope(reason: string | undefined): OverageScope {
  if (!reason) return 'unknown'
  const r = reason.toLowerCase()
  if (ORG_REASONS.has(r)) return 'org'
  if (ACCOUNT_REASONS.has(r)) return 'account'
  if (NOT_PROVISIONED_REASONS.has(r)) return 'not-provisioned'
  // Prefix fallback for values added after this table. `org_level_disabled`
  // already grew an `_until` variant once, so a new suffix must not land in
  // 'unknown' and be told to retry.
  if (r.startsWith('org_') || r.startsWith('seat_tier') || r.startsWith('group_')) return 'org'
  if (r.startsWith('member_')) return 'account'
  return 'unknown'
}

/** A rejection with no `rateLimitType` is almost always a credit block. */
export function isOverageRejection(info: ClaudeRateLimitInfo): boolean {
  if (info.rateLimitType === 'overage') return true
  if (!info.rateLimitType) return info.overageStatus === 'rejected' || info.overageStatus === undefined
  return false
}

/** Always carries the absolute date, so a next-day reset cannot read as today. */
function resetSentence(resetsAtMs: number | null, nowMs: number): string {
  if (resetsAtMs === null) return ''
  const relative = fmtResetsIn(resetsAtMs, nowMs)
  const absolute = fmtResetsAt(resetsAtMs)
  if (relative.startsWith('in ')) return ` Resets ${relative} (${absolute}).`
  if (relative === 'resetting now') return ' Resets now.'
  // The >7-day branch of fmtResetsIn is already absolute.
  return ` Resets ${absolute}.`
}

/** "five_hour" to "five-hour". */
function windowLabel(rateLimitType: string): string {
  return rateLimitType.replace(/_/g, '-')
}

/** An uncovered model is the usual reason overage applies at all. */
function modelPart(model: string | null | undefined): string {
  return model ? ` The model in use is ${model}.` : ''
}

/**
 * @param nowMs injected so the relative reset time is deterministic in tests.
 * @param model effective model id, when the caller knows it.
 */
export function buildRateLimitMessage(
  info: ClaudeRateLimitInfo,
  nowMs: number,
  model?: string | null,
): string {
  if (isOverageRejection(info)) {
    const resetsAtMs = unixSecondsToMs(info.resetsAt)
    const scope = classifyOverageScope(info.overageDisabledReason)
    const reasonPart = info.overageDisabledReason ? ` (${info.overageDisabledReason})` : ''
    const head = `Claude Code turn rejected: extra usage is unavailable${reasonPart}.${modelPart(model)}`
    const reset = resetSentence(resetsAtMs, nowMs)

    switch (scope) {
      case 'org':
        // Leads with the model: the cap is org-wide, so rotating profiles is
        // the dead end users walk into first.
        return `${head}${reset} Switching profile inside the same organisation will not help, because the spend limit is org-wide. Change the model to one your plan covers, or ask an org admin to raise the limit.`
      case 'account':
        return `${head}${reset} Extra-usage credits for this account are spent. Change the model to one your plan covers, or switch to another instance or provider.`
      case 'not-provisioned':
        return `${head} Extra usage is not set up for this account, so there is no credit to fall back on. Change the model to one your plan covers, or ask an org admin to enable extra usage.`
      case 'unknown':
        return `${head}${reset} No reason was reported, and this kind of rejection often clears on retry. Retry first, then switch instance or provider if it persists.`
    }
  }

  // A genuine rolling window. Switching credentials IS the right advice here.
  const windowPart = info.rateLimitType ? ` (${windowLabel(info.rateLimitType)} window)` : ''
  const reset = resetSentence(unixSecondsToMs(info.resetsAt), nowMs)
  return `Claude Code rate limit reached${windowPart}.${reset} Switch to another provider or instance, or wait for the window to reset.`
}
