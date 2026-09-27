import { describe, expect, it } from 'vitest'
import {
  checkLineTarget,
  checkReviewDraft,
  diffExcerpt,
  lineLocation,
  reviewFromResponse,
  reviewVerdictProblem,
} from '../../src/shared/agent-pr-review'
import type { HostWriteReview } from '../../src/shared/agent-host-writes'
import type { PrChangedFile } from '../../src/shared/pull-requests'
import { parseHunks } from '../../src/shared/unified-diff'

const files: PrChangedFile[] = [{
  path: 'w.py', oldPath: null, status: 'modified', additions: 2, deletions: 1, binary: false, truncated: false,
  hunks: parseHunks(['@@ -10,4 +10,5 @@', ' a', ' b', '-c', '+C', '+D', ' e'].join('\n')).hunks,
}]

const review: HostWriteReview = {
  summary: 'Two notes.',
  comments: [
    { id: 'c1', path: 'w.py', side: 'new', line: 12, text: 'One.', excerpt: [] },
    { id: 'c2', path: 'w.py', side: 'old', line: 12, text: 'Two.', excerpt: [] },
  ],
  verdicts: ['comment', 'approve', 'request_changes'],
}

describe('diffExcerpt', () => {
  it('returns the target and its neighbours inside the hunk, the target marked', () => {
    const lines = diffExcerpt(files, { path: 'w.py', side: 'new', line: 12 }, 1)
    expect(lines.map((l) => [l.kind, l.text, l.target])).toEqual([['del', 'c', false], ['add', 'C', true], ['add', 'D', false]])
  })

  it('finds an old-side line among deleted and context lines only', () => {
    const lines = diffExcerpt(files, { path: 'w.py', side: 'old', line: 12 }, 0)
    expect(lines).toEqual([{ kind: 'del', text: 'c', oldLine: 12, newLine: null, target: true }])
  })

  it('is empty for a line or file the diff does not show', () => {
    expect(diffExcerpt(files, { path: 'w.py', side: 'new', line: 99 }, 2)).toEqual([])
    expect(diffExcerpt(files, { path: 'x.py', side: 'new', line: 12 }, 2)).toEqual([])
  })

  it('cuts a very long line', () => {
    const long: PrChangedFile[] = [{ ...files[0], hunks: parseHunks(`@@ -1,1 +1,1 @@\n+${'z'.repeat(500)}`).hunks }]
    expect(diffExcerpt(long, { path: 'w.py', side: 'new', line: 1 }, 0)[0].text).toHaveLength(241)
  })
})

describe('checkLineTarget', () => {
  it('defaults to the new side and refuses absolute paths, bad sides and bad lines', () => {
    expect(checkLineTarget({ path: 'a.ts', line: 3 })).toEqual({ ok: true, value: { path: 'a.ts', side: 'new', line: 3 } })
    expect(checkLineTarget({ path: '/etc/passwd', line: 3 }).ok).toBe(false)
    expect(checkLineTarget({ path: 'a.ts', line: 3, side: 'LEFT' }).ok).toBe(false)
    expect(checkLineTarget({ path: 'a.ts', line: 2.5 }).ok).toBe(false)
    expect(checkLineTarget({ path: 'a.ts', line: '3' }).ok).toBe(false)
  })

  it('names the old side in a location', () => {
    expect(lineLocation({ path: 'a.ts', side: 'old', line: 3 })).toBe('a.ts:3 (old)')
    expect(lineLocation({ path: 'a.ts', side: 'new', line: 3 })).toBe('a.ts:3')
  })
})

describe('checkReviewDraft', () => {
  const comment = { path: 'w.py', line: 12, text: 'x' }

  it('accepts a summary with up to 30 comments', () => {
    const out = checkReviewDraft({ summary: ' s ', comments: Array.from({ length: 30 }, () => comment) })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.value.summary).toBe('s')
  })

  it('refuses 31 comments, a comment over 8,000 characters and a draft over 40 KiB', () => {
    expect(checkReviewDraft({ summary: 's', comments: Array.from({ length: 31 }, () => comment) }).ok).toBe(false)
    const long = checkReviewDraft({ summary: 's', comments: [{ ...comment, text: 'x'.repeat(8_001) }] })
    expect(long.ok).toBe(false)
    if (!long.ok) expect(long.message).toMatch(/^Comment 1: /)
    // Six comments of 7,000 characters: each under the cap, together over 40 KiB.
    const big = checkReviewDraft({ summary: 's', comments: Array.from({ length: 6 }, () => ({ ...comment, text: 'x'.repeat(7_000) })) })
    expect(big.ok).toBe(false)
    // Counted in UTF-8 bytes: 4,000 three-byte characters per comment is 12 KB each.
    expect(checkReviewDraft({ summary: 's', comments: Array.from({ length: 4 }, () => ({ ...comment, text: '€'.repeat(4_000) })) }).ok).toBe(false)
  })

  it('refuses an empty summary, a comments value that is not a list and an empty comment', () => {
    expect(checkReviewDraft({ summary: ' ', comments: [] }).ok).toBe(false)
    expect(checkReviewDraft({ summary: 's', comments: 'many' }).ok).toBe(false)
    expect(checkReviewDraft({ summary: 's', comments: [{ ...comment, text: '' }] }).ok).toBe(false)
  })

  it('refuses any verdict the agent tries to send', () => {
    for (const key of ['verdict', 'event', 'approve', 'requestChanges', 'request_changes']) {
      const out = checkReviewDraft({ summary: 's', comments: [], [key]: 'approve' })
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.message).toContain('the user picks')
    }
  })
})

describe('reviewVerdictProblem', () => {
  it('refuses a verdict the card did not offer, which is how an author cannot approve', () => {
    const author = { verdicts: ['comment' as const] }
    expect(reviewVerdictProblem('github', author, 'approve', 'LGTM', [])).toContain('own pull request')
    expect(reviewVerdictProblem('github', author, 'request_changes', 'Fix it', [])).toContain('own pull request')
    expect(reviewVerdictProblem('github', author, 'comment', 'Note', [])).toBeNull()
  })

  it('applies the host rules and the size rules to the edited draft', () => {
    expect(reviewVerdictProblem('github', review, 'request_changes', '', [])).toContain('GitHub needs a summary')
    expect(reviewVerdictProblem('github', review, 'comment', '', [])).not.toBeNull()
    expect(reviewVerdictProblem('github', review, 'comment', '', [{ text: 'x' }])).toBeNull()
    expect(reviewVerdictProblem('github', review, 'approve', '', [])).toBeNull()
    expect(reviewVerdictProblem('github', review, 'comment', 's', [{ text: 'a' }, { text: ' ' }])).toContain('Comment 2 is empty')
    expect(reviewVerdictProblem('github', review, 'comment', 'x'.repeat(8_001), [])).not.toBeNull()
  })
})

describe('reviewFromResponse', () => {
  it('needs a verdict from the card; the draft never supplies one', () => {
    const out = reviewFromResponse('github', review, {})
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.message).toContain('without a verdict')
  })

  it('keeps what the user kept, as edited, and counts removals and edits', () => {
    const out = reviewFromResponse('bitbucket', review, { verdict: 'approve', summary: ' New. ', comments: [{ id: 'c2', text: ' Two, edited. ' }] })
    expect(out).toEqual({
      ok: true,
      value: { verdict: 'approve', summary: 'New.', comments: [{ path: 'w.py', side: 'old', line: 12, text: 'Two, edited.' }], removed: 1, edited: 1 },
    })
  })

  it('keeps the whole draft when the card sent a verdict but no edits', () => {
    const out = reviewFromResponse('github', review, { verdict: 'comment' })
    expect(out.ok && out.value.comments.length).toBe(2)
    expect(out.ok && out.value.summary).toBe('Two notes.')
  })

  it('refuses a verdict the card did not offer', () => {
    expect(reviewFromResponse('github', { ...review, verdicts: ['comment'] }, { verdict: 'approve' }).ok).toBe(false)
  })
})
