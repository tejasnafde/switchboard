import { describe, expect, it } from 'vitest'
import { shouldFetchLiveModels, shouldFetchProviderSkills } from '../../src/renderer/components/chat/ChatInput'

describe('shouldFetchProviderSkills', () => {
  it('fetches skills for every chat agent with a provider skill registry', () => {
    expect(shouldFetchProviderSkills('claude-code')).toBe(true)
    expect(shouldFetchProviderSkills('codex')).toBe(true)
    expect(shouldFetchProviderSkills('opencode')).toBe(true)
  })

  it('does not fetch provider skills for terminal sessions', () => {
    expect(shouldFetchProviderSkills('terminal')).toBe(false)
  })
})

describe('shouldFetchLiveModels', () => {
  it('fetches live catalogs for active Claude and Codex sessions', () => {
    expect(shouldFetchLiveModels('claude-code', 'session-1', true)).toBe(true)
    expect(shouldFetchLiveModels('codex', 'session-1', true)).toBe(true)
  })

  it('waits for provider startup and ignores providers without session catalogs', () => {
    expect(shouldFetchLiveModels('codex', 'session-1', false)).toBe(false)
    expect(shouldFetchLiveModels('opencode', 'session-1', true)).toBe(false)
    expect(shouldFetchLiveModels('terminal', 'session-1', true)).toBe(false)
  })
})
