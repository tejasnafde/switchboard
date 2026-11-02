import { describe, expect, it } from 'vitest'
import { scoreModel, searchModels } from '../../src/shared/model-search'
import { CLAUDE_MODELS, OPENCODE_MODELS } from '../../src/shared/models'

const ids = (query: string, models = CLAUDE_MODELS) => searchModels(models, query).map((m) => m.id)

describe('scoreModel', () => {
  const opus = { id: 'claude-opus-5', label: 'Claude Opus 5' }

  it('scores a prefix 3, a word start 2, a substring 1 and a subsequence 0.5', () => {
    expect(scoreModel(opus, 'cla')).toBe(3)
    expect(scoreModel(opus, 'opus')).toBe(2)
    expect(scoreModel(opus, 'pus')).toBe(1)
    expect(scoreModel(opus, 'cop')).toBe(0.5)
  })

  it('needs 3 characters for a subsequence', () => {
    expect(scoreModel(opus, 'co')).toBe(0)
  })

  it('sums the words and drops a model that misses one', () => {
    expect(scoreModel(opus, 'claude opus')).toBe(5)
    expect(scoreModel(opus, 'opus sonnet')).toBe(0)
  })

  it('takes the better of label and id', () => {
    expect(scoreModel({ id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' }, 'google')).toBe(3)
  })
})

describe('searchModels', () => {
  it('keeps the catalog order for an empty query', () => {
    expect(ids('  ')).toEqual(CLAUDE_MODELS.map((m) => m.id))
  })

  it('puts word starts before substrings', () => {
    const models = [
      { id: 'a', label: 'Grandson' },
      { id: 'b', label: 'Claude Sonnet 5' },
    ]
    expect(searchModels(models, 'son').map((m) => m.id)).toEqual(['b', 'a'])
  })

  it('keeps the catalog order between equal scores', () => {
    expect(ids('sonnet')).toEqual(['claude-sonnet-5', 'claude-sonnet-4-6'])
  })

  it('finds a model by a word of its id', () => {
    expect(ids('flash', OPENCODE_MODELS)[0]).toBe('google/gemini-2.5-flash')
  })

  it('returns nothing when no model matches', () => {
    expect(ids('zzz')).toEqual([])
  })
})
