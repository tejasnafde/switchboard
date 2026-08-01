import { describe, it, expect } from 'vitest'
import {
  buildRateLimitMessage,
  classifyOverageScope,
  isOverageRejection,
} from '../../src/shared/claude-rate-limit'
import { fmtResetsAt } from '../../src/shared/provider-usage'

/**
 * Locale-proof: `fmtResetsAt` renders via `toLocaleString([])`, so hardcoding
 * "Aug 1" passed on a US CI runner and failed elsewhere with "1 Aug". What
 * matters is that a DATE is present, since the shipped bug rendered only a time.
 */
function expectCarriesAbsoluteDate(msg: string, resetsAtSeconds: number) {
  const absolute = fmtResetsAt(resetsAtSeconds * 1000)
  expect(msg).toContain(absolute)
  const timeOnly = new Date(resetsAtSeconds * 1000)
    .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  expect(absolute).not.toBe(timeOnly)
}

/**
 * The exact `rate_limit_info` logged on 2026-07-31 at 17:47:01Z, when the user
 * had just rotated Default -> Akshaya and hit the identical block. Reset is
 * 2026-08-01T00:00:00Z, i.e. the NEXT calendar day in the reporter's timezone.
 */
const LIVE_ORG_REJECTION = {
  status: 'rejected',
  resetsAt: 1785542400,
  rateLimitType: 'overage',
  overageStatus: 'rejected',
  overageDisabledReason: 'org_level_disabled_until',
  isUsingOverage: false,
}
const LIVE_NOW_MS = Date.parse('2026-07-31T17:47:01.642Z')

describe('classifyOverageScope', () => {
  it('treats a suffixed org reason as org-scoped', () => {
    // The wire grew `_until` on top of `org_level_disabled`; a suffix must not
    // fall through to advice that tells the user to switch instances.
    expect(classifyOverageScope('org_level_disabled_until')).toBe('org')
    expect(classifyOverageScope('org_level_disabled')).toBe('org')
    expect(classifyOverageScope('seat_tier_level_disabled')).toBe('org')
  })

  it('classifies every org-wide value from the SDK enum', () => {
    // Authoritative list: SDKRateLimitInfo.overageDisabledReason in sdk.d.ts.
    for (const r of [
      'org_level_disabled',
      'org_service_level_disabled',
      'org_service_zero_credit_limit',
      'seat_tier_level_disabled',
      'seat_tier_zero_credit_limit',
      'group_zero_credit_limit',
    ]) {
      expect(classifyOverageScope(r)).toBe('org')
    }
  })

  it('separates member-scoped exhaustion from org policy', () => {
    for (const r of ['out_of_credits', 'member_level_disabled', 'member_zero_credit_limit']) {
      expect(classifyOverageScope(r)).toBe('account')
    }
  })

  it('classifies the never-set-up values as not-provisioned', () => {
    expect(classifyOverageScope('overage_not_provisioned')).toBe('not-provisioned')
    expect(classifyOverageScope('no_limits_configured')).toBe('not-provisioned')
  })

  it('falls back to unknown for a missing or unrecognised reason', () => {
    expect(classifyOverageScope(undefined)).toBe('unknown')
    expect(classifyOverageScope('something_new')).toBe('unknown')
    expect(classifyOverageScope('unknown')).toBe('unknown')
  })

  it('routes an unrecognised org-looking suffix to org, not unknown', () => {
    // `org_level_disabled` already grew an `_until` variant once. A future one
    // must not be told to retry a permanent admin toggle.
    expect(classifyOverageScope('org_level_disabled_next_year')).toBe('org')
    expect(classifyOverageScope('member_something_new')).toBe('account')
  })
})

describe('isOverageRejection', () => {
  it('is true for an explicit overage rateLimitType', () => {
    expect(isOverageRejection(LIVE_ORG_REJECTION)).toBe(true)
  })

  it('is true for an empty-ish payload', () => {
    // Per the 2026-07-25 investigation, a rejection with no rateLimitType is
    // almost always a credit block rather than a real window.
    expect(isOverageRejection({ status: 'rejected' })).toBe(true)
  })

  it('is false for a real rolling window', () => {
    expect(isOverageRejection({ status: 'rejected', rateLimitType: 'five_hour' })).toBe(false)
    expect(isOverageRejection({ status: 'rejected', rateLimitType: 'seven_day' })).toBe(false)
  })
})

describe('buildRateLimitMessage: the 2026-07-31 org-level regression', () => {
  const msg = buildRateLimitMessage(LIVE_ORG_REJECTION, LIVE_NOW_MS)

  it('does NOT tell the user to switch instance, which is the dead end they hit', () => {
    // The whole point of the fix. The user had already rotated profiles.
    expect(msg).not.toMatch(/switch to another (provider or )?instance/i)
  })

  it('says the block is organisation-wide so sibling profiles are useless', () => {
    expect(msg).toMatch(/organisation/i)
    expect(msg).toMatch(/will not help/i)
  })

  it('does not call a spend cap a window, nor tell the user to wait for one', () => {
    expect(msg).not.toMatch(/window/i)
    expect(msg).not.toMatch(/wait for the window/i)
  })

  it('carries the raw reason for support and log correlation', () => {
    expect(msg).toContain('org_level_disabled_until')
  })

  it('does not falsely claim the plan limit was reached', () => {
    // five_hour was 0% and weekly 4% on this account at the time.
    expect(msg).not.toMatch(/plan limit/i)
  })
})

/**
 * Root cause, proven on 2026-07-31 by running the CLI per profile:
 *
 *   akshaya   --model claude-fable-5 -> "hit your org's monthly spend limit"
 *   tejas     --model claude-fable-5 -> same
 *   tech-team --model claude-fable-5 -> ok
 *   backend   --model claude-fable-5 -> ok
 *
 * while opus / sonnet / haiku succeeded on ALL FOUR. The two failing seats have
 * no `weekly_scoped` row in `GET /api/oauth/usage`, i.e. no plan allowance for
 * that model, so its usage bills to org credits instead of the plan windows.
 * The user never picked Fable: Switchboard sent `model=default` and the CLI
 * resolved it. So naming the model is the only way the message can point at the
 * real fix.
 */
describe('buildRateLimitMessage: naming the model', () => {
  it('names the effective model when the caller knows it', () => {
    const msg = buildRateLimitMessage(LIVE_ORG_REJECTION, LIVE_NOW_MS, 'claude-fable-5')
    expect(msg).toContain('claude-fable-5')
  })

  it('tells the user to change the model, which is the actual fix', () => {
    const msg = buildRateLimitMessage(LIVE_ORG_REJECTION, LIVE_NOW_MS, 'claude-fable-5')
    expect(msg).toMatch(/change the model/i)
    expect(msg).toMatch(/raise the limit/i)
  })

  it('still says profile rotation will not help, since the cap is org-wide', () => {
    const msg = buildRateLimitMessage(LIVE_ORG_REJECTION, LIVE_NOW_MS, 'claude-fable-5')
    expect(msg).toMatch(/switching profile .* will not help/i)
  })

  it('omits the model sentence when the model is unknown', () => {
    for (const m of [null, undefined, '']) {
      expect(buildRateLimitMessage(LIVE_ORG_REJECTION, LIVE_NOW_MS, m)).not.toMatch(/model in use/i)
    }
  })
})

describe('buildRateLimitMessage: reset timestamps', () => {
  it('includes the absolute date when the reset is on a later day', () => {
    // The shipped bug: toLocaleTimeString alone rendered "Resets 05:30 AM" for
    // a reset 6.2 hours away on 1 Aug, which reads as "later today".
    const msg = buildRateLimitMessage(LIVE_ORG_REJECTION, LIVE_NOW_MS)
    expectCarriesAbsoluteDate(msg, 1785542400)
    expect(msg).toMatch(/Resets in 6h 12m/)
  })

  it('treats resetsAt as unix seconds, not milliseconds', () => {
    const msg = buildRateLimitMessage(LIVE_ORG_REJECTION, LIVE_NOW_MS)
    // Milliseconds would land in 1970 and render a wildly wrong year.
    expect(msg).not.toMatch(/1970/)
  })

  it('keeps an absolute date for a reset weeks away', () => {
    const resetsAt = Math.floor(Date.parse('2026-09-01T00:00:00Z') / 1000)
    const msg = buildRateLimitMessage(
      { ...LIVE_ORG_REJECTION, resetsAt },
      Date.parse('2026-08-01T00:00:00Z'),
    )
    expectCarriesAbsoluteDate(msg, resetsAt)
  })

  it('omits the reset sentence entirely when resetsAt is absent', () => {
    const msg = buildRateLimitMessage({ status: 'rejected', rateLimitType: 'five_hour' }, LIVE_NOW_MS)
    expect(msg).not.toMatch(/Resets/)
  })

  it('ignores a zero or negative resetsAt rather than rendering the epoch', () => {
    expect(buildRateLimitMessage({ status: 'rejected', resetsAt: 0 }, LIVE_NOW_MS)).not.toMatch(/1970/)
    expect(buildRateLimitMessage({ status: 'rejected', resetsAt: -5 }, LIVE_NOW_MS)).not.toMatch(/1969|1970/)
  })
})

describe('buildRateLimitMessage: a real window still advises switching', () => {
  it('keeps the switch-instance advice for a five-hour window', () => {
    // Whole seconds on both sides so the relative form is exactly 1h.
    const nowMs = Date.parse('2026-07-31T18:00:00Z')
    const resetsAt = Date.parse('2026-07-31T19:00:00Z') / 1000
    const msg = buildRateLimitMessage({ status: 'rejected', rateLimitType: 'five_hour', resetsAt }, nowMs)
    expect(msg).toContain('five-hour window')
    expect(msg).toMatch(/switch to another provider or instance/i)
    expect(msg).toMatch(/Resets in 1h/)
  })

  it('hyphenates seven_day, preserving the existing label style', () => {
    const msg = buildRateLimitMessage({ status: 'rejected', rateLimitType: 'seven_day' }, LIVE_NOW_MS)
    expect(msg).toContain('seven-day')
  })
})

describe('buildRateLimitMessage: transient empty payload', () => {
  it('advises a retry first, per the 2026-07-25 finding that these clear', () => {
    const msg = buildRateLimitMessage({ status: 'rejected' }, LIVE_NOW_MS)
    expect(msg).toMatch(/retry/i)
  })
})

describe('buildRateLimitMessage: house style', () => {
  const samples = [
    LIVE_ORG_REJECTION,
    { status: 'rejected' },
    { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1785542400 },
    { status: 'rejected', rateLimitType: 'overage', overageDisabledReason: 'out_of_credits' },
    { status: 'rejected', rateLimitType: 'overage', overageDisabledReason: 'overage_not_provisioned' },
    { status: 'rejected', rateLimitType: 'overage', overageDisabledReason: 'member_level_disabled' },
  ]

  it('never emits an em dash', () => {
    for (const s of samples) {
      expect(buildRateLimitMessage(s, LIVE_NOW_MS)).not.toContain('—')
    }
  })

  it('always produces non-empty prose with no double spaces', () => {
    for (const s of samples) {
      const msg = buildRateLimitMessage(s, LIVE_NOW_MS)
      expect(msg.length).toBeGreaterThan(20)
      expect(msg).not.toMatch(/ {2}/)
      expect(msg).not.toMatch(/\.\./)
    }
  })
})
