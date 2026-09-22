import { describe, expect, it } from 'vitest'
import { COMPACTION_OFFER_MIN_IDLE_MS, COMPACTION_OFFER_MIN_TOKENS, shouldOfferCompaction } from '@shared/compaction-offer'

const now = 1_800_000_000_000
const base = {
  provider: 'claude-code' as const,
  usedTokens: COMPACTION_OFFER_MIN_TOKENS,
  lastMessageAt: now - COMPACTION_OFFER_MIN_IDLE_MS,
  busy: false,
  now,
}

describe('shouldOfferCompaction', () => {
  it('offers for a stale, heavy, idle Claude thread', () => {
    expect(shouldOfferCompaction(base)).toBe(true)
  })
  it('accepts the phone vocabulary too', () => {
    expect(shouldOfferCompaction({ ...base, provider: 'claude' })).toBe(true)
  })
  it.each([
    ['codex', { provider: 'codex' as const }],
    ['light', { usedTokens: COMPACTION_OFFER_MIN_TOKENS - 1 }],
    ['recent', { lastMessageAt: now - COMPACTION_OFFER_MIN_IDLE_MS + 1 }],
    ['busy', { busy: true }],
    ['no usage', { usedTokens: undefined }],
    ['no messages', { lastMessageAt: undefined }],
  ])('declines when %s', (_label, patch) => {
    expect(shouldOfferCompaction({ ...base, ...patch })).toBe(false)
  })
})
