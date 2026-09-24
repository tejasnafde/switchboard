import { describe, expect, it } from 'vitest'
import type { ModelOption } from '@shared/models'
import { filterModels, groupModelsByProvider } from '../../src/renderer/components/chat/provider-picker-models'

const model = (id: string, label = id): ModelOption => ({ id, label, tier: 'balanced' })

describe('filterModels', () => {
  const models = [model('claude-sonnet-5', 'Sonnet 5'), model('openai/gpt-5', 'GPT-5'), model('anthropic/claude-haiku', 'Haiku')]

  it('returns the list unchanged for a blank query', () => {
    expect(filterModels(models, '  ')).toBe(models)
  })

  it('matches the id or the label, ignoring case and surrounding space', () => {
    expect(filterModels(models, ' SONNET ').map((m) => m.id)).toEqual(['claude-sonnet-5'])
    expect(filterModels(models, 'openai/').map((m) => m.id)).toEqual(['openai/gpt-5'])
    expect(filterModels(models, 'claude').map((m) => m.id)).toEqual(['claude-sonnet-5', 'anthropic/claude-haiku'])
  })
})

describe('groupModelsByProvider', () => {
  it('keeps unprefixed ids ungrouped and groups the rest by prefix in first-seen order', () => {
    const grouped = groupModelsByProvider([
      model('sonnet'),
      model('openai/gpt-5'),
      model('anthropic/haiku'),
      model('openai/o3'),
      model('opus'),
    ])
    expect(grouped.ungrouped.map((m) => m.id)).toEqual(['sonnet', 'opus'])
    expect(grouped.groups.map((g) => [g.provider, g.models.map((m) => m.id)])).toEqual([
      ['openai', ['openai/gpt-5', 'openai/o3']],
      ['anthropic', ['anthropic/haiku']],
    ])
  })

  it('groups on the first slash only', () => {
    expect(groupModelsByProvider([model('openrouter/meta/llama')]).groups[0].provider).toBe('openrouter')
  })
})
