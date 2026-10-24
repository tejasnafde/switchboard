import { describe, expect, it } from 'vitest'
import { alignable, compactFileDiff, MAX_VISIBLE_ROWS } from '../../src/shared/compact-file-diff'
import cases from '../fixtures/compact-file-diff.json'

const seq = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n')

describe('compactFileDiff', () => {
  it.each(cases.map((c) => [c.id, c] as const))('matches the shared fixture: %s', (_id, c) => {
    expect(compactFileDiff(c.oldContent, c.newContent)).toEqual(c.expected)
  })

  it('cuts a line past 320 characters', () => {
    const added = compactFileDiff('', 'x'.repeat(400)).lines[0]
    expect(added.text).toHaveLength(320)
    expect(added.text.endsWith('…')).toBe(true)
  })

  it('treats one empty side as unalignable past the per-side bound', () => {
    expect(alignable(0, 50_000)).toBe(false)
    expect(alignable(50_000, 0)).toBe(false)
    expect(alignable(1, 200_000)).toBe(false)
    expect(alignable(0, 3_000)).toBe(true)
    expect(alignable(0, 3_001)).toBe(false)
    expect(alignable(300, 300)).toBe(true)
  })

  it('keeps huge created and deleted files within the row cap with approximate counts', () => {
    const body = seq(50_000, (i) => `line ${i}`)
    for (const diff of [compactFileDiff('', body), compactFileDiff(body, '')]) {
      expect(diff.countsExact).toBe(false)
      expect(diff.truncated).toBe(true)
      expect(diff.lines.length).toBeLessThanOrEqual(MAX_VISIBLE_ROWS)
    }
    expect(compactFileDiff('', body).addedLines).toBe(50_000)
  })

  it('bounds a 1,000-line rewrite and keeps its counts', () => {
    const diff = compactFileDiff(
      seq(1_000, (i) => `old-${i}`),
      seq(1_000, (i) => `new-${i}`),
    )
    expect(diff.truncated).toBe(true)
    expect(diff.lines.length).toBeLessThanOrEqual(MAX_VISIBLE_ROWS)
    expect(diff.addedLines).toBe(1_000)
    expect(diff.removedLines).toBe(1_000)
  })
})
