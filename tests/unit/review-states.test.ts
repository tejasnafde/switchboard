/**
 * Reviews empty and error states (one line and one fix each), the list's
 * notices, short times, the Files tree, and the unified diff parser.
 */
import { describe, expect, it } from 'vitest'
import {
  agoPhrase,
  describePrError,
  groupFilesByDir,
  reviewListState,
  rowSubtitle,
  shortAgo,
} from '../../src/renderer/components/reviews/review-states'
import { parseHunks, splitGitDiff, unquoteGitPath } from '../../src/shared/unified-diff'
import type { PrError, PrErrorKind, PrListData, PrSummary, RepoRef } from '../../src/shared/pull-requests'

const gh: RepoRef = { host: 'github', owner: 'o', name: 'switchboard' }
const bb: RepoRef = { host: 'bitbucket', owner: 'geoiq', name: 'bot' }
const err = (kind: PrErrorKind, host: PrError['host'] = 'bitbucket', message = 'x'): PrError => ({ kind, host, message })
const data = (over: Partial<PrListData>): PrListData => ({ prs: [], sources: [], unsupportedProjects: [], fetchedAt: 0, ...over })

describe('describePrError', () => {
  it('gives every error kind one line and one fix', () => {
    const kinds: PrErrorKind[] = ['no_account', 'unsupported_repo', 'token_rejected', 'rate_limited', 'offline', 'needs_desktop', 'gh_missing', 'not_found', 'unknown']
    for (const kind of kinds) {
      const n = describePrError(err(kind))
      expect(n.line.length).toBeGreaterThan(0)
      expect(n.fix.length).toBeGreaterThan(0)
      expect(n.line).not.toContain('\n')
    }
  })

  it('sends account problems to Settings and transient ones to Retry', () => {
    expect(describePrError(err('no_account')).action).toBe('settings')
    expect(describePrError(err('token_rejected', 'bitbucket')).action).toBe('settings')
    expect(describePrError(err('token_rejected', 'github')).fix).toContain('gh auth login')
    expect(describePrError(err('offline', 'github')).line).toBe('Could not reach github.com.')
    expect(describePrError(err('rate_limited', 'github')).action).toBe('retry')
    expect(describePrError(err('needs_desktop')).action).toBeNull()
  })
})

describe('reviewListState', () => {
  it('is loading before the first answer and blocked by a top-level error', () => {
    expect(reviewListState(null, null)).toEqual({ kind: 'loading' })
    expect(reviewListState(null, err('offline')).kind).toBe('blocked')
  })

  it('says when no project has a supported remote', () => {
    const state = reviewListState(data({ unsupportedProjects: ['/p/a'] }), null)
    expect(state).toMatchObject({ kind: 'blocked', notice: { id: 'unsupported' } })
    expect(reviewListState(data({}), null)).toMatchObject({ kind: 'blocked', notice: { id: 'no-projects' } })
  })

  it('blocks on one shared failure, and shows notices beside the rows otherwise', () => {
    expect(reviewListState(data({ sources: [{ repo: bb, projectPaths: [], error: err('no_account') }] }), null))
      .toMatchObject({ kind: 'blocked', notice: { id: 'bitbucket:no_account' } })
    const mixed = reviewListState(data({
      sources: [
        { repo: gh, projectPaths: [], error: null },
        { repo: bb, projectPaths: [], error: err('no_account') },
        { repo: { ...bb, name: 'other' }, projectPaths: [], error: err('no_account') },
      ],
    }), null)
    expect(mixed).toMatchObject({ kind: 'ready', notices: [{ id: 'bitbucket:no_account' }] })
  })
})

describe('times and subtitles', () => {
  const NOW = Date.parse('2026-09-27T12:00:00Z')
  it('formats short and long relative times', () => {
    expect(shortAgo(NOW - 40 * 60_000, NOW)).toBe('40 m')
    expect(shortAgo(NOW - 2 * 3_600_000, NOW)).toBe('2 h')
    expect(shortAgo(NOW - 3 * 86_400_000, NOW)).toBe('3 d')
    expect(agoPhrase(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago')
    expect(agoPhrase(NOW - 86_400_000, NOW)).toBe('yesterday')
    expect(agoPhrase(NOW - 2 * 86_400_000, NOW)).toBe('2 days ago')
  })

  it('writes the row subtitle as repo, number, and one phrase', () => {
    const pr = { ref: { ...bb, number: 612 }, state: 'open', mergedAt: null } as PrSummary
    expect(rowSubtitle(pr, 'build failed', NOW)).toBe('bot · #612 · build failed')
    expect(rowSubtitle(pr, '', NOW)).toBe('bot · #612')
    expect(rowSubtitle({ ...pr, state: 'merged', mergedAt: NOW - 2 * 86_400_000 }, '', NOW)).toBe('bot · #612 · 2 days ago')
  })
})

describe('groupFilesByDir', () => {
  it('groups by directory in first-seen order with root files last', () => {
    const groups = groupFilesByDir([{ path: 'README.md' }, { path: 'sync/worker.py' }, { path: 'tests/t.py' }, { path: 'sync/backoff.py' }])
    expect(groups.map((g) => [g.dir, g.files.map((f) => f.path)])).toEqual([
      ['sync/', ['sync/worker.py', 'sync/backoff.py']],
      ['tests/', ['tests/t.py']],
      ['./', ['README.md']],
    ])
  })
})

describe('unified diff', () => {
  it('stops at the line cap and says so', () => {
    const patch = ['@@ -1,3 +1,3 @@', ' a', '-b', '+c', '@@ -10,1 +10,1 @@', ' z'].join('\n')
    expect(parseHunks(patch, 2)).toMatchObject({ truncated: true, hunks: [{ lines: [{ text: 'a' }, { text: 'b' }] }] })
    expect(parseHunks(patch).truncated).toBe(false)
  })

  it('parses a CRLF patch like an LF one', () => {
    const patch = ['@@ -1,2 +1,2 @@ fn()', ' a', '-b', '+c'].join('\r\n')
    const parsed = parseHunks(patch)
    expect(parsed).toEqual(parseHunks(patch.replace(/\r\n/g, '\n')))
    expect(parsed.hunks[0].header).toBe('@@ -1,2 +1,2 @@ fn()')
    expect(parsed.hunks[0].lines.map((l) => l.text)).toEqual(['a', 'b', 'c'])
  })

  it('decodes git C-quoted paths (octal UTF-8 bytes, escapes) in the header and the ---/+++ lines', () => {
    const q = '"a/dir/na\\303\\257ve.py"'
    const diff = [
      `diff --git ${q} "b/dir/na\\303\\257ve.py"`,
      `--- ${q}`,
      '+++ "b/dir/na\\303\\257ve.py"',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git "a/tab\\there \\"q\\".md" b/plain.md',
      'similarity index 100%',
    ].join('\n')
    const files = splitGitDiff(diff)
    expect(files.map((f) => [f.oldPath, f.newPath])).toEqual([
      ['dir/naïve.py', 'dir/naïve.py'],
      ['tab\there "q".md', 'plain.md'],
    ])
    expect(files[0].patch.startsWith('@@ -1 +1 @@')).toBe(true)
  })

  it('leaves an unquoted path alone, backslashes included', () => {
    expect(unquoteGitPath('dir\\file.txt')).toBe('dir\\file.txt')
    expect(unquoteGitPath('"\\342\\234\\223 done"')).toBe('✓ done')
  })

  it('reads quoted paths with spaces and a pure rename', () => {
    const files = splitGitDiff('diff --git "a/x y.md" "b/z w.md"\nsimilarity index 100%\nrename from x y.md\nrename to z w.md\n')
    expect(files).toEqual([{ oldPath: 'x y.md', newPath: 'z w.md', binary: false, patch: '' }])
  })
})
