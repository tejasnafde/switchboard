import { describe, it, expect } from 'vitest'
import { detectAtTrigger, filterAtMatches } from '../../src/renderer/components/chat/atMention'

describe('detectAtTrigger', () => {
  it('fires at start of text', () => {
    expect(detectAtTrigger('@src', 4)).toEqual({ query: 'src', rangeStart: 0, rangeEnd: 4 })
  })

  it('fires after whitespace', () => {
    expect(detectAtTrigger('hi @src/main', 12)).toEqual({
      query: 'src/main',
      rangeStart: 3,
      rangeEnd: 12,
    })
  })

  it('fires with empty query just after @', () => {
    expect(detectAtTrigger('see @', 5)).toEqual({ query: '', rangeStart: 4, rangeEnd: 5 })
  })

  it('does NOT fire mid-word (no leading whitespace before @)', () => {
    // user@example.com style — common false positive we must reject
    expect(detectAtTrigger('user@example.com', 16)).toBeNull()
    expect(detectAtTrigger('foo@bar', 7)).toBeNull()
  })

  it('does NOT fire if cursor is past whitespace after @<query>', () => {
    expect(detectAtTrigger('@src foo', 8)).toBeNull()
  })

  it('allows / and . inside the query (path-shaped tokens)', () => {
    expect(detectAtTrigger('@src/foo/bar.ts', 15)).toEqual({
      query: 'src/foo/bar.ts',
      rangeStart: 0,
      rangeEnd: 15,
    })
  })

  it('treats newline as whitespace before @', () => {
    expect(detectAtTrigger('hi\n@src', 7)).toEqual({ query: 'src', rangeStart: 3, rangeEnd: 7 })
  })

  it('returns null for empty input or cursor at zero', () => {
    expect(detectAtTrigger('', 0)).toBeNull()
    expect(detectAtTrigger('hello', 0)).toBeNull()
  })
})

describe('filterAtMatches', () => {
  const files = [
    'src/main/index.ts',
    'src/renderer/App.tsx',
    'src/renderer/components/chat/ChatInput.tsx',
    'package.json',
    'tests/unit/at-mention.test.ts',
  ]

  it('returns the unsorted slice when query is empty', () => {
    expect(filterAtMatches('', files)).toEqual(files)
  })

  it('scores basename matches above directory matches', () => {
    const out = filterAtMatches('chatinput', files)
    expect(out[0]).toBe('src/renderer/components/chat/ChatInput.tsx')
  })

  it('drops non-matching paths', () => {
    expect(filterAtMatches('zzz', files)).toEqual([])
  })

  it('caps results at 50', () => {
    const big = Array.from({ length: 200 }, (_, i) => `file_${i}.ts`)
    const out = filterAtMatches('file', big)
    expect(out.length).toBeLessThanOrEqual(50)
  })
})
