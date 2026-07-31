/**
 * Projects-screen helpers: the saved order parse and the search filter.
 */
import { describe, it, expect } from 'vitest'
import { parseOrder, matchesQuery } from '../../apps/mobile/src/lib/projectList'

describe('parseOrder', () => {
  it('reads a JSON array of paths', () => {
    expect(parseOrder('["/a","/b"]')).toEqual(['/a', '/b'])
  })

  it('returns null for absent or empty input', () => {
    expect(parseOrder(null)).toBeNull()
    expect(parseOrder('')).toBeNull()
  })

  it('returns null rather than throwing on invalid JSON', () => {
    // A settings row can hold anything; the screen must fall back to scan order.
    expect(parseOrder('{not json')).toBeNull()
  })

  it('returns null when the value is valid JSON but not an array', () => {
    expect(parseOrder('{"a":1}')).toBeNull()
    expect(parseOrder('"a string"')).toBeNull()
  })

  it('drops non-string entries instead of trusting the whole array', () => {
    expect(parseOrder('["/a",2,null,"/b"]')).toEqual(['/a', '/b'])
  })
})

describe('matchesQuery', () => {
  const project = { name: 'Switchboard', path: '/Users/t/Desktop/projects/switchboard' }

  it('matches everything on an empty or whitespace query', () => {
    expect(matchesQuery(project, '')).toBe(true)
    expect(matchesQuery(project, '   ')).toBe(true)
  })

  it('matches the name case-insensitively', () => {
    expect(matchesQuery(project, 'switch')).toBe(true)
    expect(matchesQuery(project, 'BOARD')).toBe(true)
  })

  it('matches on the path, so two checkouts of one repo are separable', () => {
    expect(matchesQuery(project, 'desktop/projects')).toBe(true)
    expect(matchesQuery({ name: 'app', path: '/work/copy-two/app' }, 'copy-two')).toBe(true)
  })

  it('rejects a non-match', () => {
    expect(matchesQuery(project, 'kanban')).toBe(false)
  })

  it('ignores surrounding whitespace in the query', () => {
    expect(matchesQuery(project, '  switch  ')).toBe(true)
  })
})
