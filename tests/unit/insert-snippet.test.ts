/**
 * Unit tests for `insertSnippetWithNewlineGuards` — the pure helper behind
 * CardModal's image-paste path. The guards exist so an embedded
 * `![](data:...)` always lands on its own line regardless of where the
 * caret happens to be.
 */
import { describe, it, expect } from 'vitest'
import { insertSnippetWithNewlineGuards } from '../../src/renderer/services/insertSnippet'

describe('insertSnippetWithNewlineGuards', () => {
  it('inserts into empty body without leading or trailing newline', () => {
    expect(insertSnippetWithNewlineGuards('', 0, 0, '![](x)')).toBe('![](x)')
  })

  it('adds a leading newline when the prev char is non-newline', () => {
    expect(insertSnippetWithNewlineGuards('hello', 5, 5, '![](x)')).toBe('hello\n![](x)')
  })

  it('does not add a leading newline when the prev char is already a newline', () => {
    expect(insertSnippetWithNewlineGuards('hello\n', 6, 6, '![](x)')).toBe('hello\n![](x)')
  })

  it('adds a trailing newline when the next char is non-newline', () => {
    expect(insertSnippetWithNewlineGuards('abc', 0, 0, '![](x)')).toBe('![](x)\nabc')
  })

  it('skips trailing newline when the next char is already a newline', () => {
    expect(insertSnippetWithNewlineGuards('\nabc', 0, 0, '![](x)')).toBe('![](x)\nabc')
  })

  it('replaces a selected range with the snippet plus guards', () => {
    expect(insertSnippetWithNewlineGuards('aaa BBB ccc', 4, 7, '![](x)')).toBe('aaa \n![](x)\n ccc')
  })

  it('clamps out-of-range start/end safely', () => {
    expect(insertSnippetWithNewlineGuards('abc', -1, 99, 'X')).toBe('X')
    expect(insertSnippetWithNewlineGuards('abc', 5, 1, 'X')).toBe('abc\nX')
  })

  it('joins multi-line snippet without extra blank lines', () => {
    const out = insertSnippetWithNewlineGuards('top\nbot', 4, 4, 'one\ntwo')
    expect(out).toBe('top\none\ntwo\nbot')
  })
})
