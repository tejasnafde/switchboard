import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RECENT_SESSION_LIMIT,
  RECENT_SESSION_LIMITS,
  parseRecentSessionLimit,
  resolveLoadedRecentSessionLimit,
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

  it('uses the configured baseline until expanded', () => {
    const items = Array.from({ length: 9 }, (_, index) => index)
    expect(visibleRecentSessions(items, 6, false)).toEqual([0, 1, 2, 3, 4, 5])
    expect(visibleRecentSessions(items, 6, true)).toEqual(items)
  })

  it('does not let a late settings read overwrite a newer selection', () => {
    expect(resolveLoadedRecentSessionLimit('12', false)).toBe(12)
    expect(resolveLoadedRecentSessionLimit('12', true)).toBeNull()
  })
})
