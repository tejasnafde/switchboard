import { describe, it, expect } from 'vitest'
import { fuzzyScore } from '../../src/renderer/services/fuzzyScore'

/** Rank `targets` best-first by score, dropping non-matches. */
function rank(query: string, targets: string[]): string[] {
  return targets
    .map((t) => ({ t, s: fuzzyScore(query, t) }))
    .filter((x): x is { t: string; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.t)
}

describe('fuzzyScore', () => {
  it('returns null when query chars are not all present in order', () => {
    expect(fuzzyScore('xyz', 'abc')).toBeNull()
    expect(fuzzyScore('ba', 'ab')).toBeNull()
  })

  it('ranks an earlier in-basename match above a later one (leading-gap penalty)', () => {
    expect(rank('ab', ['x_ab', 'ab_x'])).toEqual(['ab_x', 'x_ab'])
  })

  it('prefers a basename-prefix match over a buried one', () => {
    expect(rank('app', ['myApp.tsx', 'App.tsx'])).toEqual(['App.tsx', 'myApp.tsx'])
  })

  it('still matches a basename buried deep in the path (no over-penalty)', () => {
    expect(fuzzyScore('app', 'src/components/App.tsx')).not.toBeNull()
  })

  it('prefers shorter targets on otherwise-equal matches', () => {
    expect(rank('app', ['App.tsx', 'AppShellOld.tsx'])).toEqual(['App.tsx', 'AppShellOld.tsx'])
  })
})
