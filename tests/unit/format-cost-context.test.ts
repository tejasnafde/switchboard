import { describe, expect, it } from 'vitest'
import { contextPercent, formatCostUsd } from '@shared/format'

describe('formatCostUsd', () => {
  it('keeps enough digits that a small cost still shows', () => {
    expect(formatCostUsd(0.0032)).toBe('$0.0032')
    expect(formatCostUsd(0.042)).toBe('$0.042')
    expect(formatCostUsd(1.25)).toBe('$1.25')
  })
})

describe('contextPercent', () => {
  it('is null while the limit is unknown, and clamped to 0-100', () => {
    expect(contextPercent(1000, null)).toBeNull()
    expect(contextPercent(1000, 0)).toBeNull()
    expect(contextPercent(50, 200)).toBe(25)
    expect(contextPercent(500, 200)).toBe(100)
    expect(contextPercent(-5, 200)).toBe(0)
  })
})
