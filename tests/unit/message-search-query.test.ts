import { describe, expect, it } from 'vitest'
import { parseArchiveIntent } from '../../src/shared/archive-intent'
import {
  ftsMatchExpression,
  isPhraseMatch,
  isWordPrefixMatch,
  messageSearchTerms,
  orderMessageSearchResults,
  textMatchesSearch,
} from '../../src/shared/message-search'

describe('messageSearchTerms', () => {
  it('splits on anything that is not a letter or a digit', () => {
    expect(messageSearchTerms('fix-jitter "foo.ts" C:\\path (a*) ^b c:d')).toEqual(
      ['fix', 'jitter', 'foo', 'ts', 'C', 'path', 'a', 'b', 'c', 'd'],
    )
  })

  it('keeps letters outside ASCII', () => {
    expect(messageSearchTerms('café über_日本')).toEqual(['café', 'über', '日本'])
  })

  it('drops bare FTS operators but keeps the lower-case words', () => {
    expect(messageSearchTerms('rock AND roll OR NOT NEAR and or')).toEqual(['rock', 'roll', 'and', 'or'])
  })
})

describe('ftsMatchExpression', () => {
  it('quotes every word as a prefix', () => {
    expect(ftsMatchExpression(['sync', 'jit'])).toBe('"sync"* "jit"*')
  })

  it('is null without words', () => {
    expect(ftsMatchExpression([])).toBeNull()
  })
})

describe('parseArchiveIntent', () => {
  it.each([
    ['archived deploy', true, 'deploy'],
    ['deploy ARCHIVE notes', true, 'deploy notes'],
    ['deploy', false, 'deploy'],
    ['archives deploy', false, 'archives deploy'],
    ['unarchived', false, 'unarchived'],
    ['  archived  ', true, ''],
  ])('%s', (query, includeArchived, rest) => {
    expect(parseArchiveIntent(query)).toEqual({ includeArchived, query: rest })
  })
})

describe('isPhraseMatch', () => {
  it('needs the words next to each other in order, the last as a prefix', () => {
    expect(isPhraseMatch('Fix the sync-jitter bug', ['sync', 'jit'])).toBe(true)
    expect(isPhraseMatch('jitter in sync', ['sync', 'jitter'])).toBe(false)
    expect(isPhraseMatch('async jitter', ['sync', 'jitter'])).toBe(false)
    expect(isPhraseMatch('anything', ['one'])).toBe(true)
  })
})

describe('orderMessageSearchResults', () => {
  it('puts a phrase match above a more relevant scattered match', () => {
    const order = orderMessageSearchResults([
      { id: 'scattered', rank: -5, timestamp: 9, phraseMatch: false },
      { id: 'phrase', rank: -2, timestamp: 1, phraseMatch: true },
    ])
    expect(order.map((r) => r.id)).toEqual(['phrase', 'scattered'])
  })

  it('puts the newer message first when relevance ties', () => {
    const order = orderMessageSearchResults([
      { id: 'old', rank: -3, timestamp: 1, phraseMatch: true },
      { id: 'new', rank: -3, timestamp: 2, phraseMatch: true },
      { id: 'close', rank: -2.9, timestamp: 3, phraseMatch: true },
    ])
    expect(order.map((r) => r.id)).toEqual(['close', 'new', 'old'])
  })

  it('keeps relevance above recency when the scores are far apart', () => {
    const order = orderMessageSearchResults([
      { id: 'weak', rank: -1, timestamp: 9, phraseMatch: true },
      { id: 'strong', rank: -4, timestamp: 1, phraseMatch: true },
    ])
    expect(order.map((r) => r.id)).toEqual(['strong', 'weak'])
  })

  it('keeps rows from an older backend, without rank, after ranked ones in their order', () => {
    const order = orderMessageSearchResults<{ id: string; rank?: number; timestamp?: number; phraseMatch?: boolean }>([
      { id: 'legacy-1' },
      { id: 'ranked', rank: -1, timestamp: 1, phraseMatch: true },
      { id: 'legacy-2' },
    ])
    expect(order.map((r) => r.id)).toEqual(['ranked', 'legacy-1', 'legacy-2'])
  })
})

describe('textMatchesSearch', () => {
  it('matches the typed text or every word of it', () => {
    expect(textMatchesSearch('see foo.ts here', 'foo.ts')).toBe(true)
    expect(textMatchesSearch('the sync backoff and its jitter', 'sync jitter')).toBe(true)
    expect(textMatchesSearch('the sync backoff', 'sync jitter')).toBe(false)
    expect(textMatchesSearch('anything', '   ')).toBe(false)
  })

  it('drops a bare FTS operator word even when the text itself has no "and"', () => {
    // The global search builds its FTS match expression from messageSearchTerms
    // on the un-lowercased query, which drops AND/OR/NOT/NEAR; a hit it finds
    // for "sync AND jitter" can be a message with no literal "and" in it, and
    // this in-chat check must still treat it as a match.
    expect(textMatchesSearch('the sync, then jitter settles down', 'sync AND jitter')).toBe(true)
  })
})

describe('isWordPrefixMatch', () => {
  it('rejects a term that only occurs inside a word', () => {
    expect(isWordPrefixMatch('concatenate the buffers', ['cat'])).toBe(false)
  })

  it('accepts a term that starts a word', () => {
    expect(isWordPrefixMatch('the cat sat here', ['cat'])).toBe(true)
  })

  it('requires every term to match', () => {
    expect(isWordPrefixMatch('sync jitter', ['sync', 'cat'])).toBe(false)
  })
})
