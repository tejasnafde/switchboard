import { describe, it, expect } from 'vitest'
import { groupModelsByProvider, splitModelVariant } from '../../src/renderer/components/chat/ChatInput'

describe('groupModelsByProvider', () => {
  it('keeps slashless ids in ungrouped (Claude/Codex static lists)', () => {
    const out = groupModelsByProvider([
      { id: 'claude-opus-4-5', label: 'Opus' },
      { id: 'gpt-5', label: 'GPT-5' },
    ])
    expect(out.ungrouped).toHaveLength(2)
    expect(out.groups).toHaveLength(0)
  })

  it('groups OpenCode-style ids by their provider prefix in input order', () => {
    const out = groupModelsByProvider([
      { id: 'google/gemini-3-pro', label: 'Gemini 3 Pro' },
      { id: 'nvidia-nim/x/glm-5', label: 'GLM 5' },
      { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ])
    expect(out.ungrouped).toHaveLength(0)
    expect(out.groups.map((g) => g.provider)).toEqual(['google', 'nvidia-nim'])
    expect(out.groups[0].models).toHaveLength(2)
    expect(out.groups[1].models).toHaveLength(1)
  })

  it('mixes ungrouped and grouped without losing entries', () => {
    const out = groupModelsByProvider([
      { id: 'gpt-5', label: 'GPT-5' },
      { id: 'google/gemini', label: 'Gemini' },
    ])
    expect(out.ungrouped.map((m) => m.id)).toEqual(['gpt-5'])
    expect(out.groups[0].provider).toBe('google')
  })
})

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
