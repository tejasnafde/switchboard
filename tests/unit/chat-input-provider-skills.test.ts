import { describe, expect, it } from 'vitest'
import { shouldFetchLiveModels } from '../../src/renderer/components/chat/ChatInput'

describe('shouldFetchLiveModels', () => {
  it('fetches live catalogs for active Claude and Codex sessions', () => {
    expect(shouldFetchLiveModels('claude-code', 'session-1', true)).toBe(true)
    expect(shouldFetchLiveModels('codex', 'session-1', true)).toBe(true)
  })

  it('waits for provider startup and ignores providers without session catalogs', () => {
    expect(shouldFetchLiveModels('codex', 'session-1', false)).toBe(false)
    expect(shouldFetchLiveModels('opencode', 'session-1', true)).toBe(true)
    expect(shouldFetchLiveModels('opencode', 'session-1', false)).toBe(true)
  })
})
