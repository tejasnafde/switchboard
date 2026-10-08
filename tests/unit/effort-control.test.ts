import { describe, expect, it } from 'vitest'
import {
  claudeModelEffort,
  claudeQueryEffort,
  codexWireEffort,
  effortControlFor,
  effortLabel,
  effortPick,
  parseEffortLevels,
  splitModelVariant,
} from '../../src/shared/effort'
import { claudeModelOptions } from '../../src/main/provider/claude-models'
import type { ModelOption } from '../../src/shared/models'

const claudeCatalog: ModelOption[] = [
  { id: 'default', label: 'Default', tier: 'balanced', effortLevels: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'opus[1m]', label: 'Opus', tier: 'max', resolvedModel: 'claude-opus-5', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'haiku', label: 'Haiku', tier: 'fast', effortLevels: [] },
]

describe('effortLabel', () => {
  it('names every level, an unknown variant by itself, and the base as Default', () => {
    expect(['low', 'medium', 'high', 'xhigh', 'max'].map(effortLabel)).toEqual(['Low', 'Medium', 'High', 'Extra high', 'Max'])
    expect(effortLabel('thinking')).toBe('Thinking')
    expect(effortLabel('')).toBe('Default')
  })
})

describe('parseEffortLevels', () => {
  it('keeps known levels weakest first, from strings or Codex objects', () => {
    expect(parseEffortLevels(['max', 'low', 'turbo', 'high'])).toEqual(['low', 'high', 'max'])
    expect(parseEffortLevels([{ reasoningEffort: 'xhigh' }, { reasoningEffort: 'minimal' }, null])).toEqual(['xhigh'])
    expect(parseEffortLevels('high')).toEqual([])
  })
})

describe('claudeModelEffort and claudeModelOptions', () => {
  it('uses the reported list, an empty list for no effort, and nothing when unsaid', () => {
    expect(claudeModelEffort({ supportsEffort: true, supportedEffortLevels: ['high', 'low'] })).toEqual({ effortLevels: ['low', 'high'] })
    expect(claudeModelEffort({ supportsEffort: false })).toEqual({ effortLevels: [] })
    expect(claudeModelEffort({ supportsEffort: true })).toEqual({ effortLevels: ['low', 'medium', 'high'] })
    expect(claudeModelEffort({})).toEqual({})
  })

  it('maps SDK rows verbatim with their levels', () => {
    expect(claudeModelOptions([
      { value: 'opus[1m]', displayName: 'Opus', resolvedModel: 'claude-opus-5', supportsEffort: true, supportedEffortLevels: ['low', 'max'] },
      { value: 'haiku', displayName: 'Haiku' },
    ])).toEqual([
      { id: 'opus[1m]', label: 'Opus', tier: 'max', resolvedModel: 'claude-opus-5', effortLevels: ['low', 'max'] },
      { id: 'haiku', label: 'Haiku', tier: 'fast' },
    ])
  })
})

describe('effortControlFor', () => {
  it('offers a Claude model only the levels it takes, with High as the default', () => {
    const control = effortControlFor({ agentType: 'claude-code', model: 'opus[1m]', models: claudeCatalog })
    expect(control?.choices.map((c) => c.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(control?.choices.find((c) => c.isDefault)?.value).toBe('high')
    expect(control?.value).toBe('high')
  })

  it('finds the alias row covering an explicit Claude id, and the default row when none is picked', () => {
    expect(effortControlFor({ agentType: 'claude-code', model: 'claude-opus-5', models: claudeCatalog, reasoningEffort: 'max' })?.value).toBe('max')
    expect(effortControlFor({ agentType: 'claude-code', models: claudeCatalog })?.choices).toHaveLength(4)
  })

  it('is hidden for a Claude model without effort or a catalog that has not said', () => {
    expect(effortControlFor({ agentType: 'claude-code', model: 'haiku', models: claudeCatalog })).toBeNull()
    expect(effortControlFor({ agentType: 'claude-code', model: 'claude-sonnet-5', models: [{ id: 'claude-sonnet-5', label: 'S', tier: 'balanced' }] })).toBeNull()
  })

  it('shows the default when the stored level is one this model does not take', () => {
    const control = effortControlFor({ agentType: 'claude-code', model: 'default', models: claudeCatalog, reasoningEffort: 'max' })
    expect(control?.value).toBe('high')
  })

  it('gives Codex its reported levels and default, else Low to High on Medium', () => {
    const codex: ModelOption[] = [{ id: 'gpt-6', label: 'GPT-6', tier: 'max', effortLevels: ['low', 'high', 'xhigh'], defaultEffort: 'xhigh' }]
    const reported = effortControlFor({ agentType: 'codex', model: 'gpt-6', models: codex })
    expect(reported?.choices.map((c) => c.label)).toEqual(['Low', 'High', 'Extra high'])
    expect(reported?.value).toBe('xhigh')
    const fallback = effortControlFor({ agentType: 'codex', model: 'gpt-5.2', models: [], reasoningEffort: 'high' })
    expect(fallback?.choices.map((c) => c.value)).toEqual(['low', 'medium', 'high'])
    expect(fallback?.choices.find((c) => c.isDefault)?.value).toBe('medium')
    expect(fallback?.value).toBe('high')
  })

  it('turns OpenCode variants into the levels, the base into Default', () => {
    const control = effortControlFor({ agentType: 'opencode', models: [], variants: { available: ['', 'high', 'max'], current: 'high' } })
    expect(control?.choices).toEqual([
      { value: '', label: 'Default', isDefault: false },
      { value: 'high', label: 'High', isDefault: false },
      { value: 'max', label: 'Max', isDefault: false },
    ])
    expect(control?.value).toBe('high')
    expect(effortControlFor({ agentType: 'opencode', models: [], variants: { available: [], current: '' } })).toBeNull()
  })

  it('has no control for a terminal', () => {
    expect(effortControlFor({ agentType: 'terminal', models: [] })).toBeNull()
  })
})

describe('effortPick', () => {
  it('rewrites the OpenCode model id and sets the effort for the others', () => {
    expect(effortPick('opencode', 'max', { model: 'google/gemini-3-pro/high', available: ['high', 'max'] })).toEqual({ kind: 'model', model: 'google/gemini-3-pro/max' })
    expect(effortPick('opencode', '', { model: 'google/gemini-3-pro/high', available: ['high'] })).toEqual({ kind: 'model', model: 'google/gemini-3-pro' })
    expect(effortPick('claude-code', 'xhigh')).toEqual({ kind: 'effort', effort: 'xhigh' })
    expect(effortPick('codex', 'turbo')).toBeNull()
  })
})

describe('splitModelVariant', () => {
  it('strips a known variant and leaves a base id alone', () => {
    expect(splitModelVariant('google/gemini-3-pro/high', ['low', 'high'])).toEqual({ base: 'google/gemini-3-pro', variant: 'high' })
    expect(splitModelVariant('google/gemini', ['', 'high'])).toEqual({ base: 'google/gemini', variant: '' })
  })
})

describe('what goes on the wire', () => {
  it('Claude drops a level the model does not take, and keeps one without evidence', () => {
    expect(claudeQueryEffort('max', 'haiku', claudeCatalog)).toBeUndefined()
    expect(claudeQueryEffort('max', 'claude-opus-5', claudeCatalog)).toBe('max')
    expect(claudeQueryEffort('xhigh', 'some-new-model', claudeCatalog)).toBe('xhigh')
    expect(claudeQueryEffort('max', undefined, claudeCatalog)).toBeUndefined()
  })

  it('Codex gets only a level the composer offers for the model', () => {
    const codex: ModelOption[] = [{ id: 'gpt-6', label: 'GPT-6', tier: 'max', effortLevels: ['low', 'high', 'xhigh'] }]
    expect(codexWireEffort('max', 'gpt-6', codex)).toBeUndefined()
    expect(codexWireEffort('medium', 'gpt-6', codex)).toBeUndefined()
    expect(codexWireEffort('xhigh', 'gpt-6', codex)).toBe('xhigh')
    // No catalog row: Low to High, as offered, so an older Codex never sees xhigh.
    expect(codexWireEffort('xhigh', 'gpt-5.2', codex)).toBeUndefined()
    expect(codexWireEffort('high', undefined, [])).toBe('high')
    expect(codexWireEffort(undefined, 'gpt-6', codex)).toBeUndefined()
  })
})
