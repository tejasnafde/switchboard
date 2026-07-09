import { describe, it, expect } from 'vitest'
import { inferTier } from '../../src/main/provider/adapters/claude-adapter'

/**
 * `inferTier` maps a Claude model id to the picker's tier badge for the
 * dynamic model list (SDK `supportedModels()` → UnifiedProviderPicker).
 */
describe('inferTier', () => {
  it('maps haiku/mini to fast', () => {
    expect(inferTier('claude-haiku-4-5')).toBe('fast')
    expect(inferTier('claude-3-5-haiku-latest')).toBe('fast')
    expect(inferTier('some-mini-model')).toBe('fast')
  })

  it('maps sonnet to balanced', () => {
    expect(inferTier('claude-sonnet-4-5')).toBe('balanced')
  })

  it('maps opus/fable to max', () => {
    expect(inferTier('claude-opus-4-7')).toBe('max')
    expect(inferTier('claude-fable-5')).toBe('max')
  })

  it('is case-insensitive', () => {
    expect(inferTier('Claude-Opus-4-5')).toBe('max')
  })

  it('defaults unknown families to balanced', () => {
    expect(inferTier('claude-next-9000')).toBe('balanced')
    expect(inferTier('')).toBe('balanced')
  })
})
