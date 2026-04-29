/**
 * Unit tests for shared formatting helpers.
 *
 * `fmtDuration` is used by MessageBubble to render "Worked for 1.4s" under
 * each completed assistant turn — Cursor-style indicator. Must handle:
 *   - sub-second (200 → "0.2s")
 *   - sub-minute decimals (1400 → "1.4s")
 *   - minute+second (65000 → "1m 5s")
 *   - hour+ rolls up
 *   - zero / negative degrade gracefully
 */
import { describe, it, expect } from 'vitest'
import { fmtDuration } from '../../src/shared/format'

describe('fmtDuration', () => {
  it('formats sub-second values with 1 decimal', () => {
    expect(fmtDuration(200)).toBe('0.2s')
    expect(fmtDuration(800)).toBe('0.8s')
  })

  it('formats sub-minute values with 1 decimal', () => {
    expect(fmtDuration(1400)).toBe('1.4s')
    expect(fmtDuration(12500)).toBe('12.5s')
    expect(fmtDuration(59900)).toBe('59.9s')
  })

  it('rolls into minute+second above 60s', () => {
    expect(fmtDuration(60000)).toBe('1m 0s')
    expect(fmtDuration(65000)).toBe('1m 5s')
    expect(fmtDuration(125_000)).toBe('2m 5s')
  })

  it('rolls into hour+minute above 3600s', () => {
    expect(fmtDuration(3_600_000)).toBe('1h 0m')
    expect(fmtDuration(3_900_000)).toBe('1h 5m')
  })

  it('handles 0 and negatives without throwing', () => {
    expect(fmtDuration(0)).toBe('0.0s')
    expect(fmtDuration(-50)).toBe('0.0s')
  })
})
