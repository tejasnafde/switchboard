import { describe, it, expect } from 'vitest'
import { normalizeProviderOptionMemory, switchProviderOptions } from '../../src/shared/provider-option-memory'

describe('per-provider model memory', () => {
  it('restores the model and effort a chat last used on a provider when it switches back', () => {
    const toCodex = switchProviderOptions(
      {},
      { agentType: 'claude-code', model: 'opus', reasoningEffort: null },
      'codex',
    )
    expect(toCodex.model).toBeNull()
    const codexTurn = { agentType: 'codex', model: 'gpt-5.5', reasoningEffort: 'high' as const }
    const toClaude = switchProviderOptions(toCodex.memory, codexTurn, 'claude-code')
    expect(toClaude.model).toBe('opus')
    const back = switchProviderOptions(
      toClaude.memory,
      { agentType: 'claude-code', model: 'sonnet', reasoningEffort: 'high' },
      'codex',
    )
    expect(back).toMatchObject({ model: 'gpt-5.5', reasoningEffort: 'high' })
    expect(back.memory['claude-code']).toEqual({ model: 'sonnet', reasoningEffort: 'high' })
  })

  it('keeps the current effort when the target provider has none remembered', () => {
    const out = switchProviderOptions({}, { agentType: 'codex', model: null, reasoningEffort: 'low' }, 'opencode')
    expect(out).toMatchObject({ model: null, reasoningEffort: 'low' })
  })

  it('reads a missing or damaged value as empty memory', () => {
    expect(normalizeProviderOptionMemory(null)).toEqual({})
    expect(normalizeProviderOptionMemory([1])).toEqual({})
    expect(normalizeProviderOptionMemory({ codex: { model: 'm', reasoningEffort: 'ultra' }, x: 3 })).toEqual({
      codex: { model: 'm' },
    })
  })
})
