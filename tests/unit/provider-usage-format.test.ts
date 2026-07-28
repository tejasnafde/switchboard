import { describe, it, expect } from 'vitest'
import {
  clampPercent,
  fmtResetsIn,
  isoToMs,
  kindForMinutes,
  severityForPercent,
  toPercent,
  unixSecondsToMs,
  windowLabelForMinutes,
} from '../../src/shared/provider-usage'

describe('clampPercent / toPercent', () => {
  it('passes finite numbers through', () => {
    expect(clampPercent(12)).toBe(12)
    expect(clampPercent(0)).toBe(0)
  })

  it('does not coerce strings - a wire change should be visible, not silent', () => {
    expect(clampPercent('12')).toBeNull()
    expect(toPercent('12')).toBeNull()
  })

  it('rejects non-finite values', () => {
    expect(clampPercent(NaN)).toBeNull()
    expect(clampPercent(Infinity)).toBeNull()
    expect(clampPercent(null)).toBeNull()
    expect(clampPercent(undefined)).toBeNull()
  })

  it('clamps out-of-range values for bar widths', () => {
    expect(clampPercent(150)).toBe(100)
    expect(clampPercent(-5)).toBe(0)
  })

  it('leaves overage values unclamped', () => {
    expect(toPercent(150)).toBe(150)
  })
})

describe('severityForPercent', () => {
  it('matches the ContextWindowMeter thresholds', () => {
    expect(severityForPercent(null)).toBe('ok')
    expect(severityForPercent(0)).toBe('ok')
    expect(severityForPercent(59.9)).toBe('ok')
    expect(severityForPercent(60)).toBe('ok')
    expect(severityForPercent(60.1)).toBe('warn')
    expect(severityForPercent(85)).toBe('warn')
    expect(severityForPercent(85.1)).toBe('critical')
    expect(severityForPercent(100)).toBe('critical')
  })
})

describe('windowLabelForMinutes', () => {
  it('names the known windows', () => {
    expect(windowLabelForMinutes(300)).toBe('5-hour')
    expect(windowLabelForMinutes(10080)).toBe('Weekly')
    expect(windowLabelForMinutes(43200)).toBe('30-day')
  })

  it('derives a label for unknown durations', () => {
    expect(windowLabelForMinutes(60)).toBe('1-hour')
    expect(windowLabelForMinutes(2880)).toBe('2-day')
    expect(windowLabelForMinutes(90)).toBe('90-min')
  })

  it('degrades gracefully on missing or nonsense durations', () => {
    expect(windowLabelForMinutes(null)).toBe('Usage')
    expect(windowLabelForMinutes(0)).toBe('Usage')
  })
})

describe('kindForMinutes', () => {
  it('buckets by window length', () => {
    expect(kindForMinutes(300)).toBe('session')
    expect(kindForMinutes(10080)).toBe('weekly')
    expect(kindForMinutes(43200)).toBe('monthly')
    expect(kindForMinutes(null)).toBe('other')
  })
})

describe('time conversion', () => {
  it('parses ISO with fractional seconds and an offset', () => {
    expect(isoToMs('2026-07-28T00:39:59.922303+00:00'))
      .toBe(Date.parse('2026-07-28T00:39:59.922303+00:00'))
  })

  it('returns null rather than an Invalid Date', () => {
    expect(isoToMs('not a date')).toBeNull()
    expect(isoToMs('')).toBeNull()
    expect(isoToMs(null)).toBeNull()
    expect(isoToMs(1785000000)).toBeNull()
  })

  it('converts Codex unix SECONDS to milliseconds', () => {
    expect(unixSecondsToMs(1785000000)).toBe(1785000000000)
  })

  it('rejects non-positive or non-numeric unix values', () => {
    expect(unixSecondsToMs(0)).toBeNull()
    expect(unixSecondsToMs(-1)).toBeNull()
    expect(unixSecondsToMs('1785000000')).toBeNull()
    expect(unixSecondsToMs(null)).toBeNull()
  })
})

describe('fmtResetsIn', () => {
  const now = Date.parse('2026-07-27T12:00:00Z')

  it('reports unknown and already-past windows', () => {
    expect(fmtResetsIn(null, now)).toBe('reset time unknown')
    expect(fmtResetsIn(now - 1000, now)).toBe('resetting now')
  })

  it('formats sub-hour and sub-day deltas', () => {
    expect(fmtResetsIn(now + 45_000, now)).toBe('in 45s')
    expect(fmtResetsIn(now + 20 * 60_000, now)).toBe('in 20m')
    expect(fmtResetsIn(now + (4 * 60 + 12) * 60_000, now)).toBe('in 4h 12m')
    expect(fmtResetsIn(now + 5 * 60 * 60_000, now)).toBe('in 5h')
  })

  it('formats multi-day deltas', () => {
    expect(fmtResetsIn(now + (3 * 24 + 4) * 60 * 60_000, now)).toBe('in 3d 4h')
    expect(fmtResetsIn(now + 3 * 24 * 60 * 60_000, now)).toBe('in 3d')
  })

  it('switches to an absolute date past a week, where relative stops helping', () => {
    expect(fmtResetsIn(now + 9 * 24 * 60 * 60_000, now)).toMatch(/^resets /)
  })
})
