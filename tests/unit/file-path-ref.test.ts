/**
 * Heuristics for detecting repo paths inside chat content + parsing optional
 * line ranges. Drives:
 *   - inline FileChip pills in MessageBubble (replace markdown <code> with
 *     clickable chip when text resolves to a project file)
 *   - selection-to-pill in the file viewer (reverse direction: build
 *     `path:start-end` reference from a viewer selection)
 *
 * Heuristic must be cheap (runs over every <code> in every assistant
 * message) and conservative (false positives turn random inline code into
 * broken file pills). The on-disk existence check is done elsewhere — this
 * helper just decides "is this even path-shaped".
 */
import { describe, it, expect } from 'vitest'
import { looksLikeRepoPath, parseFilePathRef, formatFilePathRef } from '../../src/shared/filePathRef'

describe('looksLikeRepoPath', () => {
  it('accepts paths with at least one slash and a file extension', () => {
    expect(looksLikeRepoPath('src/foo.ts')).toBe(true)
    expect(looksLikeRepoPath('src/main/provider/types.ts')).toBe(true)
    expect(looksLikeRepoPath('a/b.py')).toBe(true)
  })

  it('accepts paths with line-range suffixes', () => {
    expect(looksLikeRepoPath('src/foo.ts:30')).toBe(true)
    expect(looksLikeRepoPath('src/foo.ts:30-45')).toBe(true)
  })

  it('rejects strings with spaces', () => {
    expect(looksLikeRepoPath('src/foo bar.ts')).toBe(false)
    expect(looksLikeRepoPath('a b')).toBe(false)
  })

  it('rejects single-token strings without a slash', () => {
    // bare filenames are too easy to confuse with prose ("config.json")
    // — require at least one slash to count.
    expect(looksLikeRepoPath('foo.ts')).toBe(false)
    expect(looksLikeRepoPath('readme')).toBe(false)
  })

  it('rejects URLs', () => {
    expect(looksLikeRepoPath('https://example.com/path')).toBe(false)
    expect(looksLikeRepoPath('http://foo.com/x.js')).toBe(false)
  })

  it('rejects strings with no extension', () => {
    expect(looksLikeRepoPath('src/main/index')).toBe(false)
    expect(looksLikeRepoPath('a/b/c')).toBe(false)
  })

  it('rejects empty / whitespace', () => {
    expect(looksLikeRepoPath('')).toBe(false)
    expect(looksLikeRepoPath('   ')).toBe(false)
  })

  it('rejects absolute system paths to keep things repo-relative', () => {
    // We only render pills for project-relative paths; absolute paths get
    // rendered as plain code so we don't accidentally wire up a chip that
    // tries to open `/etc/passwd`.
    expect(looksLikeRepoPath('/etc/passwd')).toBe(false)
    expect(looksLikeRepoPath('/Users/tejas/Desktop/foo.ts')).toBe(false)
  })
})

describe('parseFilePathRef', () => {
  it('returns plain path when no line range present', () => {
    expect(parseFilePathRef('src/foo.ts')).toEqual({ path: 'src/foo.ts' })
  })

  it('parses single-line reference', () => {
    expect(parseFilePathRef('src/foo.ts:42')).toEqual({
      path: 'src/foo.ts',
      startLine: 42,
      endLine: 42,
    })
  })

  it('parses range reference', () => {
    expect(parseFilePathRef('src/foo.ts:30-45')).toEqual({
      path: 'src/foo.ts',
      startLine: 30,
      endLine: 45,
    })
  })

  it('returns null for non-path-shaped input', () => {
    expect(parseFilePathRef('hello world')).toBeNull()
    expect(parseFilePathRef('')).toBeNull()
  })

  it('does not silently coerce malformed line numbers', () => {
    // Zero is path-shaped enough that heuristic admits it, but parse
    // sees the invalid range and leaves :0 as part of the path string.
    expect(parseFilePathRef('src/foo.ts:0')).toEqual({ path: 'src/foo.ts:0' })
    // Negative-looking ranges fail the heuristic (`:-3` isn't `:\d+`),
    // so the whole input is rejected — better than emitting a bad chip.
    expect(parseFilePathRef('src/foo.ts:-3')).toBeNull()
  })
})

describe('formatFilePathRef (round-trip)', () => {
  it('emits bare path when no range', () => {
    expect(formatFilePathRef({ path: 'src/foo.ts' })).toBe('src/foo.ts')
  })

  it('emits single line when start === end', () => {
    expect(formatFilePathRef({ path: 'src/foo.ts', startLine: 42, endLine: 42 })).toBe(
      'src/foo.ts:42',
    )
  })

  it('emits range when start !== end', () => {
    expect(formatFilePathRef({ path: 'src/foo.ts', startLine: 30, endLine: 45 })).toBe(
      'src/foo.ts:30-45',
    )
  })

  it('round-trips parse → format', () => {
    const samples = ['src/foo.ts', 'src/foo.ts:42', 'src/main/x.py:30-45']
    for (const s of samples) {
      const parsed = parseFilePathRef(s)
      expect(parsed).not.toBeNull()
      expect(formatFilePathRef(parsed!)).toBe(s)
    }
  })
})
