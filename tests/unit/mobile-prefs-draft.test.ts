/**
 * Unsent composer text survives leaving and re-entering a chat.
 *
 * Tests the pure reducer rather than the store: the store is wrapped in
 * `persist`, which cannot load in a node test without AsyncStorage.
 */
import { describe, it, expect } from 'vitest'
import { withDraft, type ThreadPref } from '../../apps/mobile/src/stores/prefs'

const NOW = 1_700_000_000_000

describe('withDraft', () => {
  it('stores unsent text against the thread', () => {
    const next = withDraft({}, 'c:a', 'half a thought', NOW)
    expect(next?.['c:a']).toMatchObject({ draft: 'half a thought', at: NOW })
  })

  it('keeps threads separate', () => {
    const a = withDraft({}, 'c:a', 'one', NOW) ?? {}
    const both = withDraft(a, 'c:b', 'two', NOW) ?? {}
    expect(both['c:a'].draft).toBe('one')
    expect(both['c:b'].draft).toBe('two')
  })

  it('does not disturb a saved mode or model', () => {
    const start: Record<string, ThreadPref> = { 'c:a': { mode: 'plan', model: 'opus', at: 1 } }
    const next = withDraft(start, 'c:a', 'text', NOW)
    expect(next?.['c:a']).toMatchObject({ mode: 'plan', model: 'opus', draft: 'text' })
  })

  it('drops the entry when an emptied draft is all it held', () => {
    const start: Record<string, ThreadPref> = { 'c:a': { draft: 'typed', at: 1 } }
    expect(withDraft(start, 'c:a', '', NOW)).toEqual({})
  })

  it('keeps the entry when it still holds a mode', () => {
    const start: Record<string, ThreadPref> = { 'c:a': { mode: 'plan', draft: 'typed', at: 1 } }
    expect(withDraft(start, 'c:a', '', NOW)?.['c:a']).toMatchObject({ mode: 'plan', draft: '' })
  })

  it('signals no change when the text is unchanged, so the store can skip a write', () => {
    const start: Record<string, ThreadPref> = { 'c:a': { draft: 'same', at: 1 } }
    expect(withDraft(start, 'c:a', 'same', NOW)).toBeNull()
  })

  it('signals no change for an empty draft on an unknown thread', () => {
    expect(withDraft({}, 'c:new', '', NOW)).toBeNull()
  })
})
