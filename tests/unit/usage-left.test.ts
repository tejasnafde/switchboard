import { describe, expect, it } from 'vitest'
import { leftPercent, leftTone } from '../../src/shared/usage-left'

describe('leftPercent', () => {
  it.each([
    [0, 100],
    [37.4, 63],
    [100, 0],
    [130, 0],
    [-5, 100],
  ])('%s used leaves %s', (used, left) => {
    expect(leftPercent(used)).toBe(left)
  })

  it('is null when the used percent is unknown', () => {
    expect(leftPercent(null)).toBeNull()
    expect(leftPercent(Number.NaN)).toBeNull()
  })
})

describe('leftTone', () => {
  it.each([
    [0, 'error'],
    [10, 'error'],
    [11, 'warning'],
    [20, 'warning'],
    [21, 'neutral'],
    [100, 'neutral'],
    [null, 'neutral'],
  ] as const)('%s left is %s', (left, tone) => {
    expect(leftTone(left)).toBe(tone)
  })
})
