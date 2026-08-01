/**
 * Persisted per-thread preferences: the eviction rule that keeps the stored map
 * bounded on a long-lived install.
 */
import { describe, it, expect } from 'vitest'
import {
  pruneThreadPrefs,
  toggleCollapsedWorkspace,
  MAX_REMEMBERED_THREADS,
  type ThreadPref,
} from '../../apps/mobile/src/stores/prefs'

function makePrefs(n: number, startAt = 0): Record<string, ThreadPref> {
  const out: Record<string, ThreadPref> = {}
  for (let i = 0; i < n; i++) out[`conn:thread-${i}`] = { mode: 'sandbox', at: startAt + i }
  return out
}

describe('pruneThreadPrefs', () => {
  it('leaves a map under the cap untouched, by identity', () => {
    const prefs = makePrefs(5)
    expect(pruneThreadPrefs(prefs)).toBe(prefs)
  })

  it('keeps exactly the cap when over it', () => {
    expect(Object.keys(pruneThreadPrefs(makePrefs(MAX_REMEMBERED_THREADS + 50)))).toHaveLength(
      MAX_REMEMBERED_THREADS,
    )
  })

  it('drops the least recently touched entries', () => {
    // `at` ascending, so thread-0 is oldest and must be the first to go.
    const kept = pruneThreadPrefs(makePrefs(5), 3)
    expect(Object.keys(kept).sort()).toEqual(['conn:thread-2', 'conn:thread-3', 'conn:thread-4'])
  })

  it('preserves the stored values of the entries it keeps', () => {
    const prefs: Record<string, ThreadPref> = {
      a: { mode: 'plan', model: 'opus', at: 2 },
      b: { mode: 'sandbox', at: 1 },
    }
    expect(pruneThreadPrefs(prefs, 1)).toEqual({ a: { mode: 'plan', model: 'opus', at: 2 } })
  })

  it('handles an empty map', () => {
    expect(pruneThreadPrefs({}, 10)).toEqual({})
  })

  it('is stable at exactly the cap', () => {
    const prefs = makePrefs(3)
    expect(pruneThreadPrefs(prefs, 3)).toBe(prefs)
  })
})

describe('toggleCollapsedWorkspace', () => {
  it('collapses a workspace that was expanded', () => {
    expect(toggleCollapsedWorkspace([], 'ws-1')).toEqual(['ws-1'])
  })

  it('expands a workspace that was collapsed', () => {
    expect(toggleCollapsedWorkspace(['ws-1', 'ws-2'], 'ws-1')).toEqual(['ws-2'])
  })

  it('stores only collapsed ids, so an unknown workspace stays expanded', () => {
    expect(toggleCollapsedWorkspace(['ws-1'], 'ws-2')).toEqual(['ws-1', 'ws-2'])
  })

  it('does not mutate the input', () => {
    const list = ['ws-1']
    toggleCollapsedWorkspace(list, 'ws-1')
    expect(list).toEqual(['ws-1'])
  })
})
