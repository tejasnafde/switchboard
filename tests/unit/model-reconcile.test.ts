import { describe, expect, it } from 'vitest'
import { coversFor, reconcileSelectedModel } from '@shared/model-reconcile'

const row = (id: string) => ({ id, label: id, tier: 'balanced' as const })

describe('coversFor', () => {
  it('lets a Claude alias row keep a full shipped id, so no false "unavailable" warning', () => {
    expect(reconcileSelectedModel('claude-sonnet-5', { models: [row('sonnet')] }, coversFor('claude-code'))).toBe('claude-sonnet-5')
  })
  it('flags a Claude pick whose family the catalog no longer offers', () => {
    expect(reconcileSelectedModel('claude-opus-4-7', { models: [row('sonnet'), row('haiku')] }, coversFor('claude-code'))).toBeUndefined()
  })
  it('matches Codex ids exactly', () => {
    expect(reconcileSelectedModel('gpt-5.4', { models: [row('gpt-5.6-sol')] }, coversFor('codex'))).toBeUndefined()
    expect(reconcileSelectedModel('gpt-5.6-sol', { models: [row('gpt-5.6-sol')] }, coversFor('codex'))).toBe('gpt-5.6-sol')
  })
  it('never flags anything without a live catalog', () => {
    expect(reconcileSelectedModel('claude-opus-4-7', { models: [] }, coversFor('claude-code'))).toBe('claude-opus-4-7')
    expect(reconcileSelectedModel('claude-opus-4-7', null, coversFor('claude-code'))).toBe('claude-opus-4-7')
  })
})
