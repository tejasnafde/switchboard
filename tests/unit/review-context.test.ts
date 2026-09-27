import { describe, expect, it } from 'vitest'
import { conflictsItem, conversationItem, diffAround, expandReviewContext, REVIEW_LABEL_MAX_CHARS, reviewContextLabel, type ReviewContext } from '../../src/shared/review-context'
import type { PrChangedFile, PrConversation } from '../../src/shared/pull-requests'
import { parseHunks } from '../../src/shared/unified-diff'

const PR = { host: 'bitbucket' as const, owner: 'geoiq', name: 'ssg-bot-v2', number: 612 }

const file: PrChangedFile = {
  path: 'sync/worker.py', oldPath: null, status: 'modified', additions: 2, deletions: 1, binary: false, truncated: false,
  hunks: parseHunks([
    '@@ -84,7 +84,8 @@ class SyncWorker:',
    '     def backoff(self, attempt):',
    '         base = 2 ** attempt',
    '-        delay = base',
    '+        delay = min(base, 300)',
    '+        delay += jitter(delay)',
    '         return delay',
    ' ',
    '     def run(self):',
  ].join('\n')).hunks,
}

function conversation(id: string, path: string | null, line: number | null, body: string): PrConversation {
  return {
    id, path, line, side: line === null ? null : 'new', resolved: false, outdated: false,
    comments: [{ id: `${id}c`, author: { login: 'pankaj', displayName: 'Pankaj', avatarUrl: null }, body, createdAt: 0, url: null }],
  }
}

const ctx = (items: ReviewContext['items']): ReviewContext => ({ pr: PR, title: 'Sync backoff', url: 'https://bitbucket.org/geoiq/ssg-bot-v2/pull-requests/612', items })

describe('diffAround', () => {
  it('returns the hunk header and the lines around a new-side line', () => {
    expect(diffAround(file, 'new', 87, 87, 1)).toBe([
      '@@ -84,7 +84,8 @@ class SyncWorker:',
      '+        delay = min(base, 300)',
      '+        delay += jitter(delay)',
      '         return delay',
    ].join('\n'))
  })

  it('includes every hunk a selection spans', () => {
    const twoHunks: PrChangedFile = {
      ...file,
      hunks: parseHunks([
        '@@ -10,2 +10,2 @@',
        '-a = 1',
        '+a = 2',
        ' b = 1',
        '@@ -40,2 +40,2 @@',
        ' c = 1',
        '-d = 1',
        '+d = 2',
      ].join('\n')).hunks,
    }
    expect(diffAround(twoHunks, 'new', 10, 41, 0)).toBe([
      '@@ -10,2 +10,2 @@', '+a = 2', ' b = 1',
      '@@ -40,2 +40,2 @@', ' c = 1', '-d = 1', '+d = 2',
    ].join('\n'))
  })

  it('finds a removed line on the old side, and nothing outside the hunks', () => {
    expect(diffAround(file, 'old', 86, 86, 0)).toBe('@@ -84,7 +84,8 @@ class SyncWorker:\n-        delay = base')
    expect(diffAround(file, 'new', 400)).toBeNull()
    expect(diffAround(undefined, 'new', 1)).toBeNull()
  })
})

describe('review context', () => {
  const items = [
    conversationItem(conversation('a', 'sync/worker.py', 86, 'Cap the jitter too.'), [file]),
    conversationItem(conversation('b', 'sync/worker.py', 102, 'Log the attempt.'), [file]),
    conversationItem(conversation('c', 'tests/test_worker.py', 14, 'Add a case for 0.'), [file]),
  ]

  it('labels one compact pill like the mock', () => {
    expect(reviewContextLabel(ctx(items))).toBe('3 review conversations · #612 · worker.py:86, worker.py:102, test_worker.py:14')
    expect(reviewContextLabel(ctx([{ kind: 'check', name: 'integration', description: null, url: null }]))).toBe('1 failed check · #612 · integration')
  })

  it('caps the label at the length a stored pill label may have', () => {
    const many = Array.from({ length: 30 }, (_, i) => conversationItem(conversation(`x${i}`, `src/some/deep/file-${i}.ts`, i + 1, 'x'), []))
    const label = reviewContextLabel(ctx(many))
    expect(label.length).toBe(REVIEW_LABEL_MAX_CHARS)
    expect(label.endsWith('…')).toBe(true)
  })

  it('expands to a plain text block with host, repo, number, place, side, reviewer, comment and diff', () => {
    const text = expandReviewContext(ctx(items))
    expect(text).toContain('Review context from Bitbucket geoiq/ssg-bot-v2 #612: Sync backoff')
    expect(text).toContain('https://bitbucket.org/geoiq/ssg-bot-v2/pull-requests/612')
    expect(text).toContain('[1] Review conversation on sync/worker.py:86 (new side)\npankaj: Cap the jitter too.\nDiff around the line:\n@@ -84,7 +84,8 @@')
    expect(text).toContain('[3] Review conversation on tests/test_worker.py:14 (new side)\npankaj: Add a case for 0.')
    expect(text).not.toContain('left out')
  })

  it('expands a failed check and selected lines', () => {
    const text = expandReviewContext(ctx([
      { kind: 'check', name: 'integration', description: 'test_sync_resume timed out', url: 'https://ci/1' },
      { kind: 'lines', path: 'sync/worker.py', side: 'new', startLine: 86, endLine: 87, diff: diffAround(file, 'new', 86, 87, 0)! },
    ]))
    expect(text).toContain('[1] Failed check: integration\nDescription: test_sync_resume timed out\nLog: https://ci/1')
    expect(text).toContain('[2] Selected lines sync/worker.py:86-87 (new side)\n@@ -84,7 +84,8 @@ class SyncWorker:\n+        delay = min(base, 300)')
  })

  it('stays under the cap and names the items it left out', () => {
    const big = Array.from({ length: 10 }, (_, i) => conversationItem(conversation(`b${i}`, `f${i}.py`, 1, 'é'.repeat(1500)), []))
    const text = expandReviewContext(ctx(big), 12 * 1024)
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(12 * 1024)
    expect(text).toContain('[1] Review conversation on f0.py:1')
    expect(text).toMatch(/\(\d+ more items left out to stay under 12 KiB: f\d\.py:1/)
    expect(text).toContain('f9.py:1. Read them on the host.)')
  })

  it('cuts a single oversized item short and says so', () => {
    const text = expandReviewContext(ctx([conversationItem(conversation('huge', 'a.py', 1, 'x'.repeat(40_000)), [])]), 12 * 1024)
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(12 * 1024)
    expect(text).toContain('(cut short)')
    expect(text).toContain('longer than 12 KiB')
  })
})

describe('merge conflicts context', () => {
  const pr = { targetBranch: 'main', sourceBranch: 'feat/sync-backoff', conflictedFiles: ['sync/worker.py', 'sync/config.py'] }

  it('labels the pill with the base branch and the files', () => {
    expect(reviewContextLabel(ctx([conflictsItem(pr)]))).toBe('Merge conflicts with main · #612 · worker.py, config.py')
  })

  it('tells the agent to merge the base in and never rebase or force-push', () => {
    const text = expandReviewContext(ctx([conflictsItem(pr)]))
    expect(text).toContain('[1] Merge conflicts: feat/sync-backoff conflicts with main.')
    expect(text).toContain('Conflicted files: sync/worker.py, sync/config.py')
    expect(text).toContain('Merge the base branch (main) into this branch (feat/sync-backoff) and resolve the conflicts, then push. Never rebase or force-push.')
  })

  it('says the host did not name the files (GitHub)', () => {
    const item = conflictsItem({ ...pr, conflictedFiles: [] })
    expect(expandReviewContext(ctx([item]))).toContain('The host does not name the conflicted files; find them with git.')
    expect(reviewContextLabel(ctx([item]))).toBe('Merge conflicts with main · #612 · feat/sync-backoff into main')
  })
})
