import { describe, expect, it } from 'vitest'
import { skeletonSets } from '../../src/renderer/components/ui/chat-skeleton'

describe('skeletonSets', () => {
  it('covers the screen height with one set to spare, on any display', () => {
    for (const height of [600, 800, 1117, 1440, 2160, 3840]) {
      expect(skeletonSets(height) * 220).toBeGreaterThanOrEqual(height + 220)
    }
    expect(skeletonSets(0)).toBe(1)
  })
})
