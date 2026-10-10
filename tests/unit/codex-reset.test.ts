import { describe, expect, it } from 'vitest'
import {
  canOfferReset,
  fmtExpiryDate,
  isTerminalOutcome,
  parseConsumeOutcome,
  resetConfirmRows,
  resetCreditLines,
  resetResultBanner,
  resetsExpiryNote,
  soonestCreditId,
} from '../../src/shared/codex-reset'
import { buildWindow, type ProviderUsage, type UsageResetCredits } from '../../src/shared/provider-usage'

const NOW = Date.UTC(2026, 9, 11, 12, 0)
const DAY = 86_400_000

function usage(percents: [number, number], resetCredits?: UsageResetCredits, reached = false): ProviderUsage {
  return {
    instanceId: 'codex-a',
    agentType: 'codex',
    status: 'ok',
    plan: null,
    account: null,
    windows: [
      {
        ...buildWindow({
          id: 's',
          label: '5-hour',
          kind: 'session',
          percent: percents[0],
          resetsAtMs: NOW + 232 * 60_000,
          windowMinutes: 300,
        }),
        ...(reached ? { reached: true, severity: 'critical' as const } : {}),
      },
      buildWindow({
        id: 'w',
        label: 'Weekly',
        kind: 'weekly',
        percent: percents[1],
        resetsAtMs: NOW + 3 * DAY,
        windowMinutes: 10080,
      }),
    ],
    overage: [],
    ...(resetCredits ? { resetCredits } : {}),
    fetchedAtMs: NOW,
  }
}

const TWO: UsageResetCredits = {
  availableCount: 2,
  credits: [
    { id: 'late', expiresAtMs: NOW + 34 * DAY, status: 'available', title: 'Weekly limit reset' },
    { id: 'spent', expiresAtMs: NOW + 1 * DAY, status: 'redeemed', title: null },
    { id: 'soon', expiresAtMs: NOW + 19 * DAY, status: 'available', title: 'Weekly limit reset' },
  ],
}

describe('parseConsumeOutcome', () => {
  it('maps every documented outcome and nothing else', () => {
    for (const outcome of ['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'] as const) {
      expect(parseConsumeOutcome({ outcome })).toBe(outcome)
    }
    for (const body of [null, undefined, 'reset', {}, { outcome: 'resetDone' }, { outcome: 1 }]) {
      expect(parseConsumeOutcome(body)).toBe('unknown')
    }
  })

  it('treats only unknown as non-terminal', () => {
    expect(isTerminalOutcome('unknown')).toBe(false)
    for (const outcome of ['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'] as const) {
      expect(isTerminalOutcome(outcome)).toBe(true)
    }
  })
})

describe('canOfferReset', () => {
  it('offers a reset only when a window is critical and one is banked', () => {
    expect(canOfferReset(usage([34, 41], TWO))).toBe(false)
    expect(canOfferReset(usage([88, 41], TWO))).toBe(true)
    expect(canOfferReset(usage([100, 72], { availableCount: 0, credits: null }))).toBe(false)
    expect(canOfferReset(usage([100, 72]))).toBe(false)
    expect(canOfferReset(undefined)).toBe(false)
    expect(canOfferReset({ ...usage([100, 72], TWO), status: 'error' })).toBe(false)
    expect(canOfferReset({ ...usage([100, 72], TWO), agentType: 'claude-code' })).toBe(false)
  })

  it('offers on a reached flag even below the threshold', () => {
    expect(canOfferReset(usage([70, 10], TWO, true))).toBe(true)
  })

  it('waits for a window at its limit after nothingToReset', () => {
    expect(canOfferReset(usage([88, 41], TWO), true)).toBe(false)
    expect(canOfferReset(usage([100, 41], TWO), true)).toBe(true)
    expect(canOfferReset(usage([70, 41], TWO, true), true)).toBe(true)
  })
})

describe('credits', () => {
  it('names the soonest-expiring available credit, or none without a list', () => {
    expect(soonestCreditId(usage([100, 0], TWO))).toBe('soon')
    expect(soonestCreditId(usage([100, 0], { availableCount: 2, credits: null }))).toBeNull()
    expect(
      soonestCreditId(
        usage([100, 0], {
          availableCount: 2,
          credits: [
            { id: 'never', expiresAtMs: null, status: 'available', title: null },
            { id: 'dated', expiresAtMs: NOW + DAY, status: 'available', title: null },
          ],
        }),
      ),
    ).toBe('dated')
  })

  it('writes the expiry note as the mock does', () => {
    expect(resetsExpiryNote(usage([0, 0], TWO))).toBe(`next expires ${fmtExpiryDate(NOW + 19 * DAY)}`)
    expect(resetsExpiryNote(usage([0, 0], { availableCount: 1, credits: [TWO.credits![0]] }))).toBe(
      `expires ${fmtExpiryDate(NOW + 34 * DAY)}`,
    )
    expect(resetsExpiryNote(usage([0, 0], { availableCount: 2, credits: null }))).toBeNull()
    expect(fmtExpiryDate(Date.UTC(2026, 9, 30, 12))).toBe('Oct 30')
  })

  it('lists each available credit for the hover text', () => {
    expect(resetCreditLines(usage([0, 0], TWO))).toEqual([
      `Weekly limit reset · expires ${fmtExpiryDate(NOW + 19 * DAY)}`,
      `Weekly limit reset · expires ${fmtExpiryDate(NOW + 34 * DAY)}`,
    ])
  })
})

describe('resetConfirmRows', () => {
  it('shows what clears, how many remain and which credit is used', () => {
    expect(resetConfirmRows(usage([100, 72], TWO))).toEqual([
      { key: 'Clears', value: 'Codex usage limits' },
      { key: 'Remaining', value: '1' },
      { key: 'Uses', value: `The reset expiring ${fmtExpiryDate(NOW + 19 * DAY)}` },
    ])
  })

  it('leaves out Uses when only the count is known', () => {
    expect(resetConfirmRows(usage([100, 72], { availableCount: 2, credits: null })).map((r) => r.key)).toEqual([
      'Clears',
      'Remaining',
    ])
  })
})

describe('resetResultBanner', () => {
  it('uses the approved copy for every outcome', () => {
    const after = usage([0, 0], { availableCount: 1, credits: null })
    expect(resetResultBanner('reset', after, NOW)).toEqual({
      tone: 'good',
      retry: false,
      text: 'Limits reset. 1 reset remaining.',
    })
    expect(resetResultBanner('reset', usage([0, 0], { availableCount: 0, credits: null }), NOW).text).toBe(
      'Limits reset. 0 resets remaining.',
    )
    expect(resetResultBanner('alreadyRedeemed', after, NOW)).toEqual({
      tone: 'good',
      retry: false,
      text: 'This reset was already applied. No additional reset was used.',
    })
    expect(resetResultBanner('nothingToReset', after, NOW)).toEqual({
      tone: 'info',
      retry: false,
      text: 'No limit is eligible for a reset yet. Nothing was used.',
    })
    expect(resetResultBanner('unknown', after, NOW)).toEqual({
      tone: 'bad',
      retry: true,
      text: 'Codex did not respond, so the result is unknown. Retrying will not use a second reset.',
    })
  })

  it('names the critical window that frees up first on noCredit', () => {
    const at = usage([100, 72], { availableCount: 0, credits: null })
    expect(resetResultBanner('noCredit', at, NOW)).toEqual({
      tone: 'bad',
      retry: false,
      text: 'No resets available. The 5-hour limit resets in 3h 52m.',
    })
    expect(resetResultBanner('noCredit', usage([10, 10], { availableCount: 0, credits: null }), NOW).text).toBe(
      'No resets available.',
    )
  })
})
