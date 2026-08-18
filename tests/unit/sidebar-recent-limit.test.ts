import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RECENT_SESSION_LIMIT,
  RECENT_SESSION_LIMITS,
  nextRecentSessionRevealCount,
  parseRecentSessionLimit,
  resolveLoadedRecentSessionLimit,
  type RecentSessionLimit,
  visibleRecentSessions,
} from '../../src/renderer/components/sidebar/recentSessionLimit'

describe('recent session limit', () => {
  it('defaults invalid and missing settings to four rows', () => {
    expect(DEFAULT_RECENT_SESSION_LIMIT).toBe(4)
    expect(parseRecentSessionLimit(null)).toBe(4)
    expect(parseRecentSessionLimit('5')).toBe(4)
    expect(parseRecentSessionLimit('garbage')).toBe(4)
  })

  it('accepts only the compact settings choices', () => {
    expect(RECENT_SESSION_LIMITS).toEqual([4, 6, 8, 12])
    expect(RECENT_SESSION_LIMITS.map(String).map(parseRecentSessionLimit)).toEqual([4, 6, 8, 12])
  })

  it('reveals conversations in five-row increments after the configured baseline', () => {
    const items = Array.from({ length: 18 }, (_, index) => index)
    expect(visibleRecentSessions(items, 6, 0)).toEqual(items.slice(0, 6))
    expect(visibleRecentSessions(items, 6, 5)).toEqual(items.slice(0, 11))
    expect(visibleRecentSessions(items, 6, 10)).toEqual(items.slice(0, 16))
  })

  it('caps each expansion at five rows and stops at the end', () => {
    const limit: RecentSessionLimit = 6
    expect(nextRecentSessionRevealCount(443, limit, 0)).toBe(5)
    expect(nextRecentSessionRevealCount(443, limit, 5)).toBe(10)
    expect(nextRecentSessionRevealCount(13, limit, 5)).toBe(7)
  })

  it('does not let a late settings read overwrite a newer selection', () => {
    expect(resolveLoadedRecentSessionLimit('12', false)).toBe(12)
    expect(resolveLoadedRecentSessionLimit('12', true)).toBeNull()
  })
})
