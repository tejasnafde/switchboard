import { describe, it, expect } from 'vitest'
import { inferTier } from '../../src/main/provider/adapters/claude-adapter'
import { CLAUDE_MODELS, CODEX_MODELS } from '../../src/shared/models'

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

/**
 * The pre-session picker list. Verified against the ids in the Claude Code
 * binary the adapter spawns, so a typo here means a model the CLI rejects.
 */
describe('CLAUDE_MODELS', () => {
  it('assigns every entry the tier inferTier would derive from its id', () => {
    // Otherwise the pre-session list and the live model.variants list disagree
    // about the same model, and the picker's grouping jumps on session start.
    for (const m of CLAUDE_MODELS) expect(m.tier).toBe(inferTier(m.id))
  })

  it('uses bare ids with no date suffix, which is what the CLI accepts', () => {
    for (const m of CLAUDE_MODELS) expect(m.id).not.toMatch(/-\d{8}$/)
  })

  it('has no duplicate ids', () => {
    expect(new Set(CLAUDE_MODELS.map((m) => m.id)).size).toBe(CLAUDE_MODELS.length)
  })
})

/**
 * The Codex picker list. Codex has no `model.variants` event, so this array is
 * the ONLY list the user ever sees - a wrong id is a model they cannot pick.
 */
describe('CODEX_MODELS', () => {
  it('has no duplicate ids', () => {
    expect(new Set(CODEX_MODELS.map((m) => m.id)).size).toBe(CODEX_MODELS.length)
  })

  it('offers each of the three 5.6 variants at its own tier', () => {
    // Sol/Terra/Luna are one generation split by capability, not aliases. The
    // tiers come from the shipped catalog's own descriptions.
    const byId = Object.fromEntries(CODEX_MODELS.map((m) => [m.id, m.tier]))
    expect(byId['gpt-5.6-sol']).toBe('max')
    expect(byId['gpt-5.6-terra']).toBe('balanced')
    expect(byId['gpt-5.6-luna']).toBe('fast')
  })

  it('drops the -codex slugs the shipped catalog does not list', () => {
    expect(CODEX_MODELS.some((m) => m.id.includes('-codex'))).toBe(false)
  })
})
