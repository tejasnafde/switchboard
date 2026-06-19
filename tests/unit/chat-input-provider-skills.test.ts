import { describe, expect, it } from 'vitest'
import { shouldFetchProviderSkills } from '../../src/renderer/components/chat/ChatInput'

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
