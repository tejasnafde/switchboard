import { describe, it, expect } from 'vitest'
import { splitModelVariant } from '../../src/renderer/components/chat/model-variants'

describe('splitModelVariant', () => {
  it('strips a known variant suffix', () => {
    expect(splitModelVariant('google/gemini-3-pro/high', ['low', 'medium', 'high'])).toEqual({
      base: 'google/gemini-3-pro',
      variant: 'high',
    })
  })

  it('returns base when no variant matches', () => {
    expect(splitModelVariant('google/gemini-3-pro', ['low', 'high'])).toEqual({
      base: 'google/gemini-3-pro',
      variant: '',
    })
  })

  it('ignores empty-string variants in the list', () => {
    expect(splitModelVariant('google/gemini', ['', 'high'])).toEqual({
      base: 'google/gemini',
      variant: '',
    })
  })
})
