/**
 * The shared write rules: merge strategy order and default (a merge commit,
 * never squash or rebase), the merge pre-check against a fresh read, who may
 * approve, when a review can be submitted, and the backend's re-validation
 * of every write input.
 */
import { describe, expect, it } from 'vitest'
import {
  addReviewerPrecheck,
  candidatesFor,
  canRemoveReviewer,
  managePrecheck,
  orderReviewerCandidates,
  recentReviewers,
  removeReviewerPrecheck,
  validateReviewer,
  defaultMergeStrategy,
  effectiveMergeStrategy,
  lineInDiff,
  lineLocation,
  lineTargetFit,
  mergePrecheck,
  sameCommit,
  orderMergeStrategies,
  PR_REVIEW_MAX_COMMENTS,
  PR_TEXT_MAX_CHARS,
  reviewEventsFor,
  reviewSubmitProblem,
  validateComment,
  validateInlineComment,
  validateMerge,
  validateReply,
  validateRerun,
  validateResolve,
  validateSubmitReview,
} from '../../src/shared/pull-request-writes'
import { rollupChecks, type PrChangedFile, type PrDetail, type PrReviewer, type PrReviewerCandidate } from '../../src/shared/pull-requests'
import { parseHunks } from '../../src/shared/unified-diff'

function detail(over: Partial<PrDetail> = {}): PrDetail {
  return {
    ref: { host: 'github', owner: 'o', name: 'r', number: 7 }, title: 't', url: '', author: { login: 'me', displayName: 'me', avatarUrl: null }, authorId: 'me',
    state: 'open', draft: false, sourceBranch: 'f', targetBranch: 'main', createdAt: 0, updatedAt: 0, mergedAt: null,
    additions: null, deletions: null, changedFiles: null, unresolvedConversations: 0, mergeConflicts: false, conflictedFiles: [], checks: rollupChecks([]),
    reviewers: [], approvals: { given: 1, required: 1 }, viewer: { isAuthor: true, isRequestedReviewer: false, hasReviewed: false },
    projectPaths: [], description: '', headSha: 'abc1234', mergeBlockers: [], mergeStrategies: ['merge_commit', 'squash'],
    activity: [], checkList: [], viewerCanManage: true, ...over,
  }
}

describe('merge strategies', () => {
  it('lists only allowed strategies, merge commit first', () => {
    expect(orderMergeStrategies(['squash', 'rebase', 'merge_commit'])).toEqual(['merge_commit', 'squash', 'rebase'])
    expect(orderMergeStrategies(['squash', 'squash'])).toEqual(['squash'])
  })

  it('defaults to a merge commit, never squash or rebase', () => {
    expect(defaultMergeStrategy(['squash', 'rebase', 'merge_commit'])).toBe('merge_commit')
    expect(defaultMergeStrategy(['squash', 'fast_forward'])).toBe('fast_forward')
    expect(defaultMergeStrategy(['squash', 'rebase'])).toBeNull()
    expect(defaultMergeStrategy([])).toBeNull()
  })

  it('keeps a pick only while the repository allows it', () => {
    expect(effectiveMergeStrategy(['merge_commit', 'squash'], 'squash')).toBe('squash')
    expect(effectiveMergeStrategy(['merge_commit'], 'squash')).toBe('merge_commit')
    expect(effectiveMergeStrategy(['merge_commit', 'squash'], undefined)).toBe('merge_commit')
  })
})

describe('mergePrecheck', () => {
  const input = { strategy: 'merge_commit' as const, expectedHeadSha: 'abc1234' }

  it('lets an unchanged, unblocked PR merge', () => {
    expect(mergePrecheck(detail(), input)).toBeNull()
  })

  it('refuses a PR whose head moved since the user confirmed', () => {
    expect(mergePrecheck(detail({ headSha: 'fff9999' }), input)).toMatchObject({ kind: 'stale' })
    expect(mergePrecheck(detail({ headSha: null }), input)).toMatchObject({ kind: 'stale' })
  })

  it('refuses when a blocker appeared', () => {
    const error = mergePrecheck(detail({ mergeBlockers: [{ kind: 'checks_failed', label: '1 check failed' }] }), input)
    expect(error).toMatchObject({ kind: 'stale', message: 'Merging is blocked now: 1 check failed.' })
  })

  it('refuses a PR that is no longer open', () => {
    expect(mergePrecheck(detail({ state: 'merged' }), input)).toMatchObject({ kind: 'stale', message: 'This pull request is merged now.' })
  })

  it('refuses a strategy the repository does not allow', () => {
    expect(mergePrecheck(detail({ mergeStrategies: ['squash'] }), input)).toMatchObject({ kind: 'invalid' })
  })
})

describe('reviews', () => {
  it('never offers the author Approve or Request changes', () => {
    expect(reviewEventsFor({ isAuthor: true })).toEqual(['comment'])
    expect(reviewEventsFor({ isAuthor: false })).toEqual(['comment', 'approve', 'request_changes'])
  })

  it('needs a summary or a comment for Comment, and a summary for Request changes', () => {
    expect(reviewSubmitProblem('github', 'comment', '  ', 0)).not.toBeNull()
    expect(reviewSubmitProblem('github', 'comment', '', 2)).toBeNull()
    expect(reviewSubmitProblem('github', 'approve', '', 0)).toBeNull()
    expect(reviewSubmitProblem('github', 'request_changes', '', 3)).toBe('GitHub needs a summary to request changes.')
    expect(reviewSubmitProblem('bitbucket', 'request_changes', 'Fix the cap', 0)).toBeNull()
  })
})

describe('input validation', () => {
  it('accepts GitHub node ids and Bitbucket numeric ids only on their own host', () => {
    expect(validateReply('github', { conversationId: 'PRRT_kwDOAbc123', body: 'ok' }).ok).toBe(true)
    expect(validateReply('bitbucket', { conversationId: 'PRRT_kwDOAbc123', body: 'ok' }).ok).toBe(false)
    expect(validateReply('bitbucket', { conversationId: '812', body: 'ok' }).ok).toBe(true)
    expect(validateResolve('bitbucket', { conversationId: '0' }).ok).toBe(false)
    expect(validateResolve('github', { conversationId: '../x' }).ok).toBe(false)
    expect(validateResolve('github', null).ok).toBe(false)
  })

  it('trims text and refuses empty, oversized and NUL-bearing bodies', () => {
    expect(validateComment('github', { body: '  hi  ' })).toEqual({ ok: true, value: { body: 'hi' } })
    expect(validateComment('github', { body: '   ' }).ok).toBe(false)
    expect(validateComment('github', { body: 'x'.repeat(PR_TEXT_MAX_CHARS + 1) }).ok).toBe(false)
    expect(validateComment('github', { body: 'a\u0000b' }).ok).toBe(false)
    expect(validateComment('github', { body: 42 }).ok).toBe(false)
  })

  it('checks line comment paths, sides and line numbers', () => {
    const ok = { path: 'src/a.ts', side: 'new', line: 10, body: 'b' }
    expect(validateInlineComment('github', ok)).toEqual({ ok: true, value: ok })
    expect(validateInlineComment('github', { ...ok, startLine: 8 })).toEqual({ ok: true, value: { ...ok, startLine: 8 } })
    // A one-line range is the line itself.
    expect(validateInlineComment('github', { ...ok, startLine: 10 })).toEqual({ ok: true, value: ok })
    for (const bad of [
      { ...ok, path: '/etc/passwd' },
      { ...ok, path: '' },
      { ...ok, side: 'left' },
      { ...ok, line: 0 },
      { ...ok, line: 1.5 },
      { ...ok, line: '10' },
      { ...ok, startLine: 11 },
    ]) {
      expect(validateInlineComment('github', bad).ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('checks the review type, the comments and the review rules', () => {
    const c = { path: 'a.ts', side: 'new', line: 3, body: 'b' }
    expect(validateSubmitReview('github', { event: 'approve', body: '', comments: [] }).ok).toBe(true)
    expect(validateSubmitReview('github', { event: 'merge', body: '', comments: [] }).ok).toBe(false)
    expect(validateSubmitReview('github', { event: 'comment', body: '', comments: [] }).ok).toBe(false)
    expect(validateSubmitReview('github', { event: 'comment', body: '', comments: [c] }).ok).toBe(true)
    expect(validateSubmitReview('github', { event: 'comment', body: '', comments: [{ ...c, line: -1 }] }).ok).toBe(false)
    expect(validateSubmitReview('github', { event: 'comment', body: 'x', comments: 'no' }).ok).toBe(false)
    expect(validateSubmitReview('github', { event: 'comment', body: '', comments: Array(PR_REVIEW_MAX_COMMENTS + 1).fill(c) }).ok).toBe(false)
  })

  it('accepts only the merge strategy enum and a commit sha', () => {
    expect(validateMerge('github', { strategy: 'merge_commit', expectedHeadSha: 'abc1234' }).ok).toBe(true)
    expect(validateMerge('github', { strategy: 'octopus', expectedHeadSha: 'abc1234' }).ok).toBe(false)
    expect(validateMerge('github', { strategy: 'squash', expectedHeadSha: 'main' }).ok).toBe(false)
    expect(validateMerge('github', { strategy: 'squash' }).ok).toBe(false)
  })

  it('needs a check id to re-run', () => {
    expect(validateRerun('github', { checkId: 'run:0:unit' }).ok).toBe(true)
    expect(validateRerun('github', { checkId: '' }).ok).toBe(false)
    expect(validateRerun('github', {}).ok).toBe(false)
  })
})

describe('lineInDiff', () => {
  const files: PrChangedFile[] = [{
    path: 'a.py', oldPath: null, status: 'modified', additions: 2, deletions: 1, binary: false, truncated: false,
    hunks: parseHunks('@@ -10,3 +10,4 @@\n ctx\n-old\n+new1\n+new2\n ctx2').hunks,
  }]

  it('finds a shown line on its side', () => {
    expect(lineInDiff(files, { path: 'a.py', side: 'new', line: 11 })).toBe(true)
    expect(lineInDiff(files, { path: 'a.py', side: 'old', line: 11 })).toBe(true)
    expect(lineInDiff(files, { path: 'a.py', side: 'new', line: 10, startLine: 10 })).toBe(true)
  })

  it('refuses a line the diff does not show, or another file', () => {
    expect(lineInDiff(files, { path: 'a.py', side: 'new', line: 40 })).toBe(false)
    expect(lineInDiff(files, { path: 'a.py', side: 'old', line: 13 })).toBe(false)
    expect(lineInDiff(files, { path: 'b.py', side: 'new', line: 11 })).toBe(false)
    expect(lineInDiff(files, { path: 'a.py', side: 'new', line: 12, startLine: 2 })).toBe(false)
  })
})

describe('lineTargetFit', () => {
  const files: PrChangedFile[] = [{
    path: 'a.py', oldPath: null, status: 'modified', additions: 3, deletions: 1, binary: false, truncated: false,
    hunks: parseHunks('@@ -10,3 +10,4 @@\n ctx\n-old\n+new1\n+new2\n ctx2\n@@ -40,2 +41,3 @@\n far\n+added\n far2').hunks,
  }]

  it('takes a range inside one hunk on either side', () => {
    expect(lineTargetFit(files, { path: 'a.py', side: 'new', line: 13, startLine: 10 })).toBe('ok')
    expect(lineTargetFit(files, { path: 'a.py', side: 'old', line: 12, startLine: 10 })).toBe('ok')
    expect(lineInDiff(files, { path: 'a.py', side: 'new', line: 43, startLine: 41 })).toBe(true)
  })

  it('calls a range across two hunks split, and a range with an end off the diff missing', () => {
    expect(lineTargetFit(files, { path: 'a.py', side: 'new', line: 42, startLine: 11 })).toBe('split')
    expect(lineInDiff(files, { path: 'a.py', side: 'new', line: 42, startLine: 11 })).toBe(false)
    expect(lineTargetFit(files, { path: 'a.py', side: 'new', line: 30, startLine: 11 })).toBe('missing')
    expect(lineTargetFit(files, { path: 'b.py', side: 'new', line: 11 })).toBe('missing')
  })

  it('labels a range with both ends', () => {
    expect(lineLocation({ path: 'a.py', side: 'new', line: 13, startLine: 10 })).toBe('a.py:10-13')
    expect(lineLocation({ path: 'a.py', side: 'new', line: 13 })).toBe('a.py:13')
  })
})

describe('sameCommit', () => {
  it('ignores case', () => {
    expect(sameCommit('ABCDEF1234567', 'abcdef1234567')).toBe(true)
  })
  it('never matches a short hash to a longer one', () => {
    expect(sameCommit('a1b2c3d4e5f6', 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0')).toBe(false)
  })
  it('rejects different commits and a missing hash', () => {
    expect(sameCommit('a1b2c3d4e5f6', 'a1b2c3d4e5f7')).toBe(false)
    expect(sameCommit(null, 'a1b2c3d4e5f6')).toBe(false)
  })
})

// ─── Reviewers and decline ────────────────────────────────────────

const UUID = '{3f2a8b10-1c2d-4e5f-8a9b-0c1d2e3f4a5b}'
const person = (login: string) => ({ login, displayName: login, avatarUrl: null })
const rv = (id: string, state: PrReviewer['state'], requested = true): PrReviewer => ({ id, person: person(id), state, requested })
const cand = (id: string, over: Partial<PrReviewerCandidate> = {}): PrReviewerCandidate => ({ id, person: person(id), kind: 'user', reviewed: 0, ...over })

describe('reviewer validation', () => {
  it('takes GitHub logins and team slugs, and Bitbucket account uuids only', () => {
    expect(validateReviewer('github', { reviewer: 'pankaj-k' })).toEqual({ ok: true, value: { reviewer: 'pankaj-k' } })
    expect(validateReviewer('github', { reviewer: 'team:core-devs' }).ok).toBe(true)
    expect(validateReviewer('bitbucket', { reviewer: UUID }).ok).toBe(true)
    for (const [host, reviewer] of [
      ['github', '-starts-with-dash'],
      ['github', 'has space'],
      ['github', '../../orgs'],
      ['github', ''],
      ['bitbucket', 'pankaj'],
      ['bitbucket', 'team:core'],
      ['bitbucket', '{not-a-uuid}'],
    ] as const) {
      expect(validateReviewer(host, { reviewer }), `${host} ${reviewer}`).toMatchObject({ ok: false, error: { kind: 'invalid' } })
    }
    expect(validateReviewer('github', null)).toMatchObject({ ok: false, error: { kind: 'invalid' } })
  })
})

describe('reviewer and decline pre-checks', () => {
  it('refuses a closed PR as stale and a viewer the host does not allow as forbidden', () => {
    expect(managePrecheck(detail({ state: 'closed' }), 'close it')).toMatchObject({ kind: 'stale' })
    expect(managePrecheck(detail({ viewerCanManage: false }), 'close it')).toMatchObject({ kind: 'forbidden', message: expect.stringContaining('write access') })
    expect(managePrecheck(detail(), 'close it')).toBeNull()
  })

  it('does not add someone twice, or the author', () => {
    const pr = detail({ reviewers: [rv('pankaj', 'pending')] })
    expect(addReviewerPrecheck(pr, { reviewer: 'pankaj' })).toMatchObject({ kind: 'stale' })
    expect(addReviewerPrecheck(pr, { reviewer: 'me' })).toMatchObject({ kind: 'invalid' })
    expect(addReviewerPrecheck(pr, { reviewer: 'akshaya' })).toBeNull()
    expect(addReviewerPrecheck({ ...pr, authorId: 'Me' }, { reviewer: 'ME' })).toMatchObject({ kind: 'invalid' })
  })

  it('refuses the Bitbucket author by account uuid, which is what the write sends', () => {
    const bb = detail({ ref: { host: 'bitbucket', owner: 'o', name: 'r', number: 7 }, author: person('tejas'), authorId: UUID })
    expect(addReviewerPrecheck(bb, { reviewer: UUID })).toMatchObject({ kind: 'invalid', message: 'The author cannot review their own pull request.' })
    expect(addReviewerPrecheck(bb, { reviewer: '{00000000-0000-4000-8000-00000000000b}' })).toBeNull()
  })

  it('removes only a reviewer still on the PR, and on GitHub only a pending request', () => {
    const pr = detail({ reviewers: [rv('pankaj', 'pending'), rv('akshaya', 'approved'), rv('backend', 'commented', false)] })
    expect(removeReviewerPrecheck(pr, { reviewer: 'pankaj' })).toBeNull()
    expect(removeReviewerPrecheck(pr, { reviewer: 'akshaya' })).toMatchObject({ kind: 'invalid' })
    expect(removeReviewerPrecheck(pr, { reviewer: 'backend' })).toMatchObject({ kind: 'stale' })
    expect(removeReviewerPrecheck(pr, { reviewer: 'nobody' })).toMatchObject({ kind: 'stale' })
    expect(canRemoveReviewer('bitbucket', rv(UUID, 'approved'))).toBe(true)
    expect(canRemoveReviewer('bitbucket', { ...rv(UUID, 'pending'), id: null })).toBe(false)
  })
})

describe('reviewer candidates', () => {
  it('puts recent reviewers first, most reviews first, then members, people before teams', () => {
    const recent = recentReviewers([
      { reviewers: [rv('backend', 'approved'), rv('pankaj', 'commented'), rv('akshaya', 'pending')] },
      { reviewers: [rv('backend', 'changes_requested')] },
    ])
    expect(recent.map((c) => [c.id, c.reviewed])).toEqual([['backend', 2], ['pankaj', 1]])
    const members = [cand('team:core', { kind: 'team' }), cand('zed'), cand('backend'), cand('barath')]
    expect(orderReviewerCandidates(recent, members).map((c) => c.id)).toEqual(['backend', 'pankaj', 'barath', 'zed', 'team:core'])
  })

  it('leaves out the author and anyone already asked', () => {
    const pr = { author: person('me'), authorId: 'me', reviewers: [rv('pankaj', 'pending'), rv('backend', 'commented', false)] }
    expect(candidatesFor([cand('me'), cand('pankaj'), cand('backend'), cand('barath')], pr).map((c) => c.id)).toEqual(['backend', 'barath'])
    // Bitbucket: the candidate id is the uuid, not the nickname.
    expect(candidatesFor([cand(UUID, { person: person('Tejas Nafde') })], { author: person('tejas'), authorId: UUID, reviewers: [] })).toEqual([])
  })
})
