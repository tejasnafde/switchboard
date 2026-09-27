import { describe, expect, it } from 'vitest'
import { clipBytes, diffPage, matchesPathFilter, PR_DIFF_LINE_CHARS, PR_DIFF_PAGE_BYTES } from '../../src/main/mcp/pr-diff-page'
import type { DiffLine, PrChangedFile } from '../../src/shared/pull-requests'

const heading = 'Diff of GitHub acme/app #612.'
const bytes = (s: string) => new TextEncoder().encode(s).length

function file(path: string, lines: number, opts: Partial<PrChangedFile> = {}, text = (i: number) => `line ${i} ${'x'.repeat(60)}`): PrChangedFile {
  const diff: DiffLine[] = Array.from({ length: lines }, (_, i) => ({ kind: 'add', text: text(i + 1), oldLine: null, newLine: i + 1 }))
  return {
    path, oldPath: null, status: 'added', additions: lines, deletions: 0, binary: false, truncated: false,
    hunks: lines > 0 ? [{ header: `@@ -0,0 +1,${lines} @@`, oldStart: 0, newStart: 1, lines: diff }] : [],
    ...opts,
  }
}

function pageOf(files: PrChangedFile[], req: { path?: string; page?: number } = {}) {
  const out = diffPage(files, { heading, ...req })
  if (!out.ok) throw new Error(out.message)
  return out
}

describe('diffPage', () => {
  it('puts a small diff on one page with how to read the columns', () => {
    const out = pageOf([file('a.ts', 3)])
    expect(out.pages).toBe(1)
    expect(out.text.startsWith(`${heading}\nColumns: old line, new line`)).toBe(true)
    expect(out.text).toContain('=== a.ts (added, +3 -0)')
    expect(out.text).toContain('+  1 | line 1')
    expect(out.text).toContain('--- Page 1 of 1. 1 of 1 changed files match.')
    expect(out.text).not.toContain('Next:')
  })

  it('keeps every page under the cap and says what the others hold and what to call next', () => {
    const files = Array.from({ length: 12 }, (_, i) => file(`src/f${i}.ts`, 150))
    const first = pageOf(files)
    expect(first.pages).toBeGreaterThan(2)
    for (let page = 1; page <= first.pages; page++) {
      expect(bytes(pageOf(files, { page }).text)).toBeLessThanOrEqual(PR_DIFF_PAGE_BYTES)
    }
    expect(first.text).toContain('Next: call get_pr_diff with page: 2.')
    expect(first.text).toMatch(/On other pages \(in whole or in part\): .*src\/f11\.ts/)
    const last = pageOf(files, { page: first.pages })
    expect(last.text).not.toContain('Next:')
    expect(last.text).not.toContain('Columns:')
  })

  it('never splits a file that fits on a page of its own', () => {
    const files = [file('a.ts', 500), file('b.ts', 500)]
    const one = pageOf(files, { page: 1 }).text
    const two = pageOf(files, { page: 2 }).text
    expect(one).toContain('=== a.ts')
    expect(one).not.toContain('=== b.ts')
    expect(two).toContain('=== b.ts (added, +500 -0)\n')
  })

  it('splits a file bigger than a page, repeating its header as continued', () => {
    const files = [file('huge.ts', 3_000)]
    const first = pageOf(files)
    expect(first.pages).toBeGreaterThan(1)
    const second = pageOf(files, { page: 2 }).text
    expect(second).toContain('=== huge.ts (added, +3000 -0) (continued)')
    expect(second).toContain('@@ -0,0 +1,3000 @@ (continued)')
    for (let page = 1; page <= first.pages; page++) expect(bytes(pageOf(files, { page }).text)).toBeLessThanOrEqual(PR_DIFF_PAGE_BYTES)
  })

  it('filters to a file or a directory, and says what the filter left out', () => {
    const files = [file('src/a.ts', 1), file('src/deep/b.ts', 1), file('srcx/c.ts', 1), file('new.ts', 1, { oldPath: 'src/old.ts', status: 'renamed' })]
    const dir = pageOf(files, { path: 'src/' }).text
    expect(dir).toContain('=== src/a.ts')
    expect(dir).toContain('=== src/deep/b.ts')
    expect(dir).toContain('=== new.ts (renamed, renamed from src/old.ts')
    expect(dir).not.toContain('=== srcx/c.ts')
    expect(dir).toContain('3 of 4 changed files match')
    expect(dir).toContain('Not matched by "src/": srcx/c.ts.')
    expect(pageOf(files, { path: 'srcx/c.ts' }).text).toContain('1 of 4 changed files match')
    expect(matchesPathFilter({ path: 'src/a.ts', oldPath: null }, 'src/a')).toBe(false)
  })

  it('refuses a filter that matches nothing and a page that does not exist', () => {
    const files = [file('a.ts', 1)]
    const none = diffPage(files, { heading, path: 'docs' })
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.message).toContain('Changed files: a.ts')
    for (const page of [0, 2, 1.5]) {
      const out = diffPage(files, { heading, page })
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.message).toContain('There is 1 page')
    }
    expect(diffPage(files, { heading, path: 'x'.repeat(1_001) }).ok).toBe(false)
  })

  it('cuts very long lines and says so', () => {
    const out = pageOf([file('min.js', 2, {}, () => 'y'.repeat(PR_DIFF_LINE_CHARS + 50))]).text
    expect(out).toContain('… (line cut)')
    expect(out).toContain(`2 lines longer than ${PR_DIFF_LINE_CHARS} characters were cut.`)
  })

  it('never cuts a line inside a surrogate pair', () => {
    const out = pageOf([file('emoji.txt', 1, {}, () => `${'a'.repeat(PR_DIFF_LINE_CHARS - 1)}\u{1F600}tail`)]).text
    expect(out).toContain(`${'a'.repeat(PR_DIFF_LINE_CHARS - 1)}… (line cut)`)
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })

  it('names binary, truncated and hunkless files instead of showing nothing', () => {
    const out = pageOf([
      file('logo.png', 0, { binary: true }),
      file('big.sql', 1, { truncated: true }),
      file('moved.ts', 0, { status: 'renamed', oldPath: 'old.ts' }),
    ]).text
    expect(out).toContain('=== logo.png (added, +0 -0)\n(binary file, no diff)')
    expect(out).toContain('(the host cut this patch short; the rest is only on the host)')
    expect(out).toContain('(no diff lines: a rename or a mode change)')
  })

  it('shows both line numbers for context and deleted lines', () => {
    const f: PrChangedFile = {
      path: 'w.py', oldPath: null, status: 'modified', additions: 1, deletions: 1, binary: false, truncated: false,
      hunks: [{ header: '@@ -9,2 +9,2 @@', oldStart: 9, newStart: 9, lines: [
        { kind: 'context', text: 'a', oldLine: 9, newLine: 9 },
        { kind: 'del', text: 'b', oldLine: 10, newLine: null },
        { kind: 'add', text: 'c', oldLine: null, newLine: 10 },
      ] }],
    }
    const out = pageOf([f]).text
    expect(out).toContain('  9  9 | a\n-10    | b\n+   10 | c\n')
  })

  it('keeps every page within the byte cap with long multi-byte paths, headers and many files', () => {
    // Multi-byte paths far past what a page shows: every path is over 1.5 KiB in UTF-8.
    const longDir = `docs/${'文'.repeat(300)}`
    const files: PrChangedFile[] = Array.from({ length: 60 }, (_, i) => file(
      `${longDir}/${'🙂'.repeat(200)}-${i}.md`,
      i % 10 === 0 ? 300 : 20,
      { oldPath: `${longDir}/old-${'é'.repeat(900)}-${i}.md`, status: 'renamed' },
      (n) => `${'ß'.repeat(399)} ${n}`,
    ))
    for (const f of files) f.hunks = f.hunks.map((h) => ({ ...h, header: `${h.header} ${'函数'.repeat(800)}` }))
    // Files the filter leaves out, with paths as long, so the footer carries two full lists.
    const unmatched = Array.from({ length: 40 }, (_, i) => file(`other/${'語'.repeat(1_000)}-${i}.ts`, 3))
    const heading = `Diff of GitHub ${'組織'.repeat(500)}/repo #1.`
    for (const req of [{}, { path: longDir }]) {
      const all = [...files, ...unmatched]
      const first = diffPage(all, { heading, ...req })
      expect(first.ok).toBe(true)
      if (!first.ok) continue
      expect(first.pages).toBeGreaterThan(3)
      for (let page = 1; page <= first.pages; page++) {
        const out = diffPage(all, { heading, ...req, page })
        if (!out.ok) throw new Error(out.message)
        expect(Buffer.byteLength(out.text, 'utf8')).toBeLessThanOrEqual(PR_DIFF_PAGE_BYTES)
      }
    }
  })

  it('clips a path it shows on a code point boundary', () => {
    expect(clipBytes('ab🙂cd', 7)).toBe('ab…')
    expect(clipBytes('short', 300)).toBe('short')
    expect(Buffer.byteLength(clipBytes('🙂'.repeat(500), 300))).toBeLessThanOrEqual(300)
  })

  it('says a PR with no changed files has none', () => {
    expect(pageOf([]).text).toBe('This pull request changes no files.')
  })
})
