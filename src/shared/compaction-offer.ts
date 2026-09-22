/** Mirrors t3code's resume-compaction nudge: a Claude thread that is both
 *  token-heavy and stale is cheaper to continue after `/compact`. */
export const COMPACTION_OFFER_MIN_TOKENS = 100_000
export const COMPACTION_OFFER_MIN_IDLE_MS = 70 * 60_000

export interface CompactionOfferInput {
  /** Desktop sessions say 'claude-code', the phone's ProviderKind says 'claude'. */
  provider: string | undefined
  usedTokens: number | undefined
  lastMessageAt: number | undefined
  busy: boolean
  now: number
}

export function shouldOfferCompaction(input: CompactionOfferInput): boolean {
  // Claude only. Codex has /compact too but its adapter reports no
  // compaction status, so the meter would not move after the click.
  if ((input.provider !== 'claude-code' && input.provider !== 'claude') || input.busy) return false
  if (!input.usedTokens || input.usedTokens < COMPACTION_OFFER_MIN_TOKENS) return false
  if (!input.lastMessageAt) return false
  return input.now - input.lastMessageAt >= COMPACTION_OFFER_MIN_IDLE_MS
}
