/**
 * Unit tests for `computeTargetSize` — the pure half of the image-downscale
 * helper. The DOM-using `downscaleImage` itself isn't unit-tested here
 * (canvas APIs aren't available under vitest's node environment); the
 * dimension math is the high-risk part and lives behind a pure boundary.
 */
import { describe, it, expect } from 'vitest'
import { computeTargetSize } from '../../src/renderer/services/imageDownscale'

describe('computeTargetSize', () => {
  it('passes through when both dimensions are within budget', () => {
    expect(computeTargetSize(800, 600, 1920)).toEqual({ width: 800, height: 600, scaled: false })
    expect(computeTargetSize(1920, 1080, 1920)).toEqual({ width: 1920, height: 1080, scaled: false })
  })

  it('scales down a wide image to maxEdge on the long side', () => {
    const r = computeTargetSize(3840, 2160, 1920)
    expect(r.scaled).toBe(true)
    expect(r.width).toBe(1920)
    expect(r.height).toBe(1080)
  })

  it('scales down a tall image to maxEdge on the long side', () => {
    const r = computeTargetSize(1000, 4000, 1920)
    expect(r.scaled).toBe(true)
    expect(r.height).toBe(1920)
    expect(r.width).toBe(480)
  })

  it('preserves aspect ratio under non-trivial maxEdge', () => {
    const r = computeTargetSize(2400, 1600, 1200)
    expect(r.scaled).toBe(true)
    expect(r.width).toBe(1200)
    // 1600 * (1200/2400) = 800
    expect(r.height).toBe(800)
  })

  it('rounds dimensions to integers', () => {
    const r = computeTargetSize(1001, 333, 500)
    expect(Number.isInteger(r.width)).toBe(true)
    expect(Number.isInteger(r.height)).toBe(true)
  })

  it('returns input unchanged for zero / negative dimensions', () => {
    expect(computeTargetSize(0, 100, 1920)).toEqual({ width: 0, height: 100, scaled: false })
    expect(computeTargetSize(100, -1, 1920)).toEqual({ width: 100, height: -1, scaled: false })
  })
})
