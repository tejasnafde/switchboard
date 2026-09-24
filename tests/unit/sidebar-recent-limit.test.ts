import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RECENT_SESSION_LIMIT,
  RECENT_SESSION_LIMITS,
  parseRecentSessionLimit,
  resolveLoadedRecentSessionLimit,
} from '../../src/renderer/components/sidebar/recent-session-limit'

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

  it('does not let a late settings read overwrite a newer selection', () => {
    expect(resolveLoadedRecentSessionLimit('12', false)).toBe(12)
    expect(resolveLoadedRecentSessionLimit('12', true)).toBeNull()
  })
})
