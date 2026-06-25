import { describe, it, expect } from 'vitest'
import { referenceAction } from '../../src/renderer/components/files/editor/extensions/referencesPeek'

describe('referenceAction', () => {
  it('does nothing for zero references', () => {
    expect(referenceAction(0)).toBe('none')
    expect(referenceAction(-1)).toBe('none')
  })
  it('auto-jumps for a single reference', () => {
    expect(referenceAction(1)).toBe('jump')
  })
  it('opens the peek panel for multiple references', () => {
    expect(referenceAction(2)).toBe('peek')
    expect(referenceAction(25)).toBe('peek')
  })
})
