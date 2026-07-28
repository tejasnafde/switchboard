import { describe, it, expect } from 'vitest'
import { parseClaudeUsage } from '../../src/shared/claude-usage-parse'

/**
 * Trimmed from a real `GET /api/oauth/usage` response. Note the shape that
 * matters most: the per-model weekly limit is in `limits[]` as
 * `weekly_scoped` with `is_active: false`, while `seven_day_opus` and
 * `seven_day_sonnet` are null.
 */
const REAL_RESPONSE = {
  five_hour: {
    utilization: 12.0,
    resets_at: '2026-07-28T00:39:59.922303+00:00',
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
  },
  seven_day: {
    utilization: 40.0,
    resets_at: '2026-07-29T21:59:59.922321+00:00',
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
  },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [
    { kind: 'session', group: 'session', percent: 12, severity: 'normal', resets_at: '2026-07-28T00:39:59.922303+00:00', scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 40, severity: 'normal', resets_at: '2026-07-29T21:59:59.922321+00:00', scope: null, is_active: true },
    { kind: 'weekly_scoped', group: 'weekly', percent: 21, severity: 'normal', resets_at: '2026-07-29T21:59:59.922321+00:00', is_active: false, scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
  ],
  extra_usage: {
    is_enabled: true,
    monthly_limit: 2000,
    used_credits: 2009.0,
    utilization: 100.0,
    currency: 'USD',
    decimal_places: 2,
    disabled_reason: null,
    user_disabled: false,
    spend_limit_reached: false,
    credits_ever_enabled: true,
  },
  spend: {
    used: { amount_minor: 2009, currency: 'USD', exponent: 2 },
    limit: { amount_minor: 2000, currency: 'USD', exponent: 2 },
    percent: 100,
    severity: 'critical',
    enabled: true,
  },
}

describe('parseClaudeUsage - validity sentinel', () => {
  it('rejects bodies with no known limit field', () => {
    for (const body of [{}, null, [], 'error', 42, '<html>500</html>']) {
      expect(parseClaudeUsage(body).ok).toBe(false)
    }
  })

  it('accepts a body carrying any single sentinel key', () => {
    expect(parseClaudeUsage({ five_hour: null }).ok).toBe(true)
    expect(parseClaudeUsage({ limits: [] }).ok).toBe(true)
    expect(parseClaudeUsage({ extra_usage: null }).ok).toBe(true)
  })

  it('ignores unknown extra keys', () => {
    expect(parseClaudeUsage({ five_hour: { utilization: 1 }, brand_new_bucket: { x: 1 } }).ok).toBe(true)
  })
})

describe('parseClaudeUsage - windows', () => {
  it('extracts all three windows from a real response', () => {
    const out = parseClaudeUsage(REAL_RESPONSE)
    expect(out.ok).toBe(true)
    expect(out.windows.map((w) => w.label)).toEqual([
      '5-hour session',
      'Weekly',
      'Weekly (Fable)',
    ])
    expect(out.windows.map((w) => w.usedPercent)).toEqual([12, 40, 21])
  })

  it('does not multiply utilization - this endpoint is already 0-100', () => {
    const out = parseClaudeUsage({ five_hour: { utilization: 12.0, resets_at: null } })
    expect(out.windows[0]?.usedPercent).toBe(12)
  })

  it('distinguishes a real zero from a missing number', () => {
    expect(parseClaudeUsage({ five_hour: { utilization: 0 } }).windows[0]?.usedPercent).toBe(0)
    expect(parseClaudeUsage({ five_hour: {} }).windows[0]?.usedPercent).toBeNull()
  })

  it('parses a fractional-second ISO reset', () => {
    const out = parseClaudeUsage(REAL_RESPONSE)
    expect(out.windows[0]?.resetsAtMs).toBe(Date.parse('2026-07-28T00:39:59.922303+00:00'))
  })

  it('returns null rather than an Invalid Date for a malformed reset', () => {
    const out = parseClaudeUsage({ five_hour: { utilization: 5, resets_at: 'nope' } })
    expect(out.windows[0]?.resetsAtMs).toBeNull()
  })

  it('produces no row for the legacy null seven_day_opus / seven_day_sonnet', () => {
    const out = parseClaudeUsage(REAL_RESPONSE)
    expect(out.windows.some((w) => w.label.toLowerCase().includes('opus'))).toBe(false)
    expect(out.windows.some((w) => w.label.toLowerCase().includes('sonnet'))).toBe(false)
  })

  it('keeps a weekly_scoped row even when is_active is false', () => {
    // is_active marks which limit is currently binding, not whether it
    // exists. The per-model row is routinely false and must still render.
    const out = parseClaudeUsage(REAL_RESPONSE)
    const fable = out.windows.find((w) => w.label === 'Weekly (Fable)')
    expect(fable).toBeDefined()
    expect(fable?.kind).toBe('model')
  })

  it('does not double-render session / weekly_all alongside the top-level buckets', () => {
    const out = parseClaudeUsage(REAL_RESPONSE)
    expect(out.windows.filter((w) => w.label === '5-hour session')).toHaveLength(1)
    expect(out.windows.filter((w) => w.label === 'Weekly')).toHaveLength(1)
  })

  it('falls back to limits[] when the top-level buckets are absent', () => {
    const out = parseClaudeUsage({
      limits: [
        { kind: 'session', group: 'session', percent: 7, resets_at: null },
        { kind: 'weekly_all', group: 'weekly', percent: 8, resets_at: null },
      ],
    })
    expect(out.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ['5-hour session', 7],
      ['Weekly', 8],
    ])
  })

  it('falls back to a generic label when a scoped entry has no model', () => {
    const out = parseClaudeUsage({
      limits: [{ kind: 'weekly_scoped', group: 'weekly', percent: 3, resets_at: null, scope: null }],
    })
    expect(out.windows[0]?.label).toBe('Weekly (scoped)')
  })

  it('handles several scoped models', () => {
    const out = parseClaudeUsage({
      limits: [
        { kind: 'weekly_scoped', group: 'weekly', percent: 21, resets_at: null, scope: { model: { display_name: 'Fable' } } },
        { kind: 'weekly_scoped', group: 'weekly', percent: 4, resets_at: null, scope: { model: { display_name: 'Opus' } } },
      ],
    })
    expect(out.windows.map((w) => w.label)).toEqual(['Weekly (Fable)', 'Weekly (Opus)'])
  })

  it('clamps an over-range window percentage', () => {
    const out = parseClaudeUsage({ five_hour: { utilization: 150 } })
    expect(out.windows[0]?.usedPercent).toBe(100)
  })

  it('renders dollar detail when the endpoint supplies it', () => {
    const out = parseClaudeUsage({ five_hour: { utilization: 10, used_dollars: 4.1, limit_dollars: 35 } })
    expect(out.windows[0]?.detail).toBe('$4.10 of $35.00')
    expect(parseClaudeUsage({ five_hour: { utilization: 10 } }).windows[0]?.detail).toBeUndefined()
  })
})

describe('parseClaudeUsage - overage', () => {
  it('reports overage separately and leaves window severity alone', () => {
    const out = parseClaudeUsage(REAL_RESPONSE)
    expect(out.overage).toHaveLength(1)
    expect(out.overage[0]?.usedPercent).toBe(100)
    // The account is at 100% overage while both real windows are allowed.
    // Folding these together would render a healthy account as cut off.
    expect(out.windows.every((w) => w.severity !== 'critical')).toBe(true)
  })

  it('does not clamp overage above 100', () => {
    const out = parseClaudeUsage({ extra_usage: { is_enabled: true, utilization: 140 } })
    expect(out.overage[0]?.usedPercent).toBe(140)
  })

  it('formats spend from minor units', () => {
    expect(parseClaudeUsage(REAL_RESPONSE).overage[0]?.detail).toBe('$20.09 of $20.00')
  })

  it('handles an exponent of zero', () => {
    const out = parseClaudeUsage({
      extra_usage: { is_enabled: true, utilization: 10 },
      spend: { used: { amount_minor: 7, currency: 'USD', exponent: 0 }, limit: { amount_minor: 10, currency: 'USD', exponent: 0 } },
    })
    expect(out.overage[0]?.detail).toBe('$7 of $10')
  })

  it('carries the disabled reason through', () => {
    const out = parseClaudeUsage({
      extra_usage: { is_enabled: false, utilization: 100, disabled_reason: 'org_spend_cap_reached' },
    })
    expect(out.overage[0]?.enabled).toBe(false)
    expect(out.overage[0]?.blockedReason).toBe('org_spend_cap_reached')
  })

  it('emits no overage row when neither field is present', () => {
    expect(parseClaudeUsage({ five_hour: { utilization: 1 } }).overage).toEqual([])
  })

  it('falls back to credit counts when spend is absent', () => {
    const out = parseClaudeUsage({
      extra_usage: { is_enabled: true, utilization: 50, used_credits: 1000, monthly_limit: 2000 },
    })
    expect(out.overage[0]?.detail).toBe('1000 of 2000 credits')
  })
})

describe('parseClaudeUsage - regressions', () => {
  it('does not throw on an out-of-range spend exponent', () => {
    // `exponent` comes off the wire and feeds toFixed, which throws a
    // RangeError outside 0-100. This is the one input that used to escape
    // the error-result contract and surfaced as a raw RangeError message.
    for (const exponent of [-1, 101, 1e9, NaN]) {
      const body = {
        limits: [],
        spend: { enabled: true, used: { amount_minor: 500, currency: 'USD', exponent }, limit: { amount_minor: 1000, currency: 'USD', exponent } },
      }
      expect(() => parseClaudeUsage(body)).not.toThrow()
      expect(parseClaudeUsage(body).ok).toBe(true)
    }
  })

  it('emits no overage row for an empty extra_usage object', () => {
    // Otherwise a bare "Extra usage / off" line renders and masks the
    // "no plan limits reported" case upstream.
    expect(parseClaudeUsage({ extra_usage: {} }).overage).toEqual([])
    expect(parseClaudeUsage({ five_hour: { utilization: 3 }, extra_usage: {} }).overage).toEqual([])
  })
})
