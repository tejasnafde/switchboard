import { describe, it, expect } from 'vitest'
import { parseCodexRateLimits } from '../../src/shared/codex-usage-parse'

/** Trimmed from a real `account/rateLimits/read` result on a `go` plan. */
const REAL_RESULT = {
  rateLimits: {
    limitId: 'codex',
    limitName: null,
    primary: { usedPercent: 0, windowDurationMins: 43200, resetsAt: 1787773606 },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: null },
    individualLimit: null,
    planType: 'go',
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: 'codex',
      limitName: null,
      primary: { usedPercent: 0, windowDurationMins: 43200, resetsAt: 1787773606 },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: null },
      individualLimit: null,
      planType: 'go',
      rateLimitReachedType: null,
    },
  },
  rateLimitResetCredits: {
    availableCount: 3,
    credits: [{ id: 'RateLimitResetCredit_3b2b', resetType: 'codexRateLimits', status: 'available' }],
  },
}

describe('parseCodexRateLimits - real payload', () => {
  it('produces exactly one window for a single-bucket go plan', () => {
    const out = parseCodexRateLimits(REAL_RESULT)
    expect(out.ok).toBe(true)
    expect(out.windows).toHaveLength(1)
    expect(out.windows[0]?.label).toBe('30-day')
    expect(out.windows[0]?.windowMinutes).toBe(43200)
    expect(out.plan).toBe('go')
  })

  it('converts resetsAt from unix SECONDS to milliseconds', () => {
    // The single highest-value assertion here: treating this as ms yields 1970.
    expect(parseCodexRateLimits(REAL_RESULT).windows[0]?.resetsAtMs).toBe(1787773606 * 1000)
  })

  it('does not duplicate the backward-compatible rateLimits view', () => {
    expect(parseCodexRateLimits(REAL_RESULT).windows).toHaveLength(1)
  })

  it('surfaces reset credits as an overage row', () => {
    const out = parseCodexRateLimits(REAL_RESULT)
    expect(out.overage.find((o) => o.id === 'reset_credits')?.detail).toBe('3 available')
  })

  it('emits no credits row when the account has none', () => {
    expect(parseCodexRateLimits(REAL_RESULT).overage.some((o) => o.label === 'Credits')).toBe(false)
  })
})

describe('parseCodexRateLimits - window shapes', () => {
  const snap = (over: Record<string, unknown>) => ({ rateLimits: { limitId: 'codex', ...over } })

  it('omits the second row when secondary is null', () => {
    const out = parseCodexRateLimits(snap({ primary: { usedPercent: 5 }, secondary: null }))
    expect(out.windows).toHaveLength(1)
  })

  it('renders both rows, primary first, when secondary is present', () => {
    const out = parseCodexRateLimits(snap({
      primary: { usedPercent: 5, windowDurationMins: 300 },
      secondary: { usedPercent: 50, windowDurationMins: 10080 },
    }))
    expect(out.windows.map((w) => w.label)).toEqual(['5-hour', 'Weekly'])
  })

  it('renders a window that only carries usedPercent', () => {
    const out = parseCodexRateLimits(snap({ primary: { usedPercent: 33, windowDurationMins: null, resetsAt: null } }))
    expect(out.windows[0]).toMatchObject({ usedPercent: 33, windowMinutes: null, resetsAtMs: null })
  })

  it('maps known window durations to labels', () => {
    const label = (mins: number) =>
      parseCodexRateLimits(snap({ primary: { usedPercent: 1, windowDurationMins: mins } })).windows[0]?.label
    expect(label(300)).toBe('5-hour')
    expect(label(10080)).toBe('Weekly')
    expect(label(43200)).toBe('30-day')
    expect(label(60)).toBe('1-hour')
  })

  it('rejects the snake_case dialect instead of silently reading undefined', () => {
    // These field names belong to Codex's other protocol. Reading them here
    // would yield undefined for every value and render an empty panel.
    const out = parseCodexRateLimits(snap({ primary: { used_percent: 42, window_minutes: 300, resets_at: 1787773606 } }))
    expect(out.ok).toBe(false)
    expect(out.windows).toHaveLength(0)
    expect(out.error).toMatch(/snake_case/)
  })

  it('merges multiple limit ids and prefixes their labels', () => {
    const out = parseCodexRateLimits({
      rateLimitsByLimitId: {
        codex: { limitId: 'codex', primary: { usedPercent: 10, windowDurationMins: 43200 } },
        other: { limitId: 'other', primary: { usedPercent: 20, windowDurationMins: 10080 } },
      },
    })
    expect(out.windows.map((w) => w.label).sort()).toEqual(['30-day (codex)', 'Weekly (other)'])
  })

  it('converts individualLimit remaining into a used percentage', () => {
    const out = parseCodexRateLimits(snap({
      individualLimit: { limit: '$100', used: '$25', remainingPercent: 75, resetsAt: 1787773606 },
    }))
    const spend = out.windows.find((w) => w.label === 'Spend limit')
    expect(spend?.usedPercent).toBe(25)
    expect(spend?.detail).toBe('$25 of $100')
  })

  it('treats a fully consumed spend control as 100 percent', () => {
    const out = parseCodexRateLimits(snap({ individualLimit: { limit: '$1', used: '$1', remainingPercent: 0, resetsAt: 1 } }))
    expect(out.windows.find((w) => w.label === 'Spend limit')?.usedPercent).toBe(100)
  })
})

describe('parseCodexRateLimits - plan and reached state', () => {
  it('passes every plan type through', () => {
    const plans = ['free', 'go', 'plus', 'pro', 'prolite', 'team', 'self_serve_business_usage_based',
      'business', 'enterprise_cbp_usage_based', 'enterprise', 'edu', 'unknown']
    for (const planType of plans) {
      expect(parseCodexRateLimits({ rateLimits: { limitId: 'c', planType, primary: { usedPercent: 1 } } }).plan)
        .toBe(planType)
    }
    expect(parseCodexRateLimits({ rateLimits: { limitId: 'c', primary: { usedPercent: 1 } } }).plan).toBeNull()
  })

  it('forces critical when a rolling limit was reached', () => {
    const out = parseCodexRateLimits({
      rateLimits: { limitId: 'c', primary: { usedPercent: 5 }, rateLimitReachedType: 'rate_limit_reached' },
    })
    expect(out.windows[0]?.severity).toBe('critical')
  })

  it('does not redden a healthy window when only credits are depleted', () => {
    const out = parseCodexRateLimits({
      rateLimits: { limitId: 'c', primary: { usedPercent: 5 }, rateLimitReachedType: 'workspace_owner_credits_depleted' },
    })
    expect(out.windows[0]?.severity).toBe('ok')
  })

  it('reports unlimited and balance-carrying credits', () => {
    expect(parseCodexRateLimits({ rateLimits: { limitId: 'c', credits: { hasCredits: true, unlimited: true } } })
      .overage[0]?.detail).toBe('Unlimited')
    expect(parseCodexRateLimits({ rateLimits: { limitId: 'c', credits: { hasCredits: true, unlimited: false, balance: '12' } } })
      .overage[0]?.detail).toBe('12 available')
  })
})

describe('parseCodexRateLimits - degenerate input', () => {
  it('flags an all-null snapshot as unknown rather than an error', () => {
    const out = parseCodexRateLimits({ rateLimits: null, rateLimitsByLimitId: null, rateLimitResetCredits: null })
    expect(out.ok).toBe(true)
    expect(out.allNull).toBe(true)
  })

  it('ignores dailyUsageBuckets', () => {
    const out = parseCodexRateLimits({
      rateLimits: { limitId: 'c', primary: { usedPercent: 3 } },
      dailyUsageBuckets: [{ startDate: '2026-07-01', tokens: 100 }],
    })
    expect(out.ok).toBe(true)
    expect(out.windows).toHaveLength(1)
  })

  it('never throws on garbage', () => {
    for (const body of [null, [], 42, 'nope', {}]) {
      expect(() => parseCodexRateLimits(body)).not.toThrow()
    }
    expect(parseCodexRateLimits(null).ok).toBe(false)
    expect(parseCodexRateLimits({}).allNull).toBe(true)
  })
})

describe('parseCodexRateLimits - regressions', () => {
  it('flags a present-but-empty limits map as allNull, not ok-with-no-rows', () => {
    // Previously fell through both the error and allNull branches, rendering
    // a panel header with nothing under it and no explanation.
    expect(parseCodexRateLimits({ rateLimitsByLimitId: {} }).allNull).toBe(true)
    expect(parseCodexRateLimits({ rateLimits: { limitId: 'c' } }).allNull).toBe(true)
  })

  it('keeps reset credits when no window snapshot exists', () => {
    // An early return used to discard these.
    const out = parseCodexRateLimits({ rateLimitResetCredits: { availableCount: 3, credits: null } })
    expect(out.overage.map((o) => o.id)).toEqual(['reset_credits'])
    expect(out.allNull).toBe(false)
  })
})
