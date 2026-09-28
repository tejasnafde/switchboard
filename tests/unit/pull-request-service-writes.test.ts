/**
 * The service in front of every write: it re-validates the input, re-reads
 * what the write targets, and only then calls the host. A refused write
 * never reaches the provider; a done write names the reads to refresh.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/logger', () => ({ createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))

import { PullRequestService } from '../../src/main/pull-requests/service'
import { PrHostError, type PullRequestProvider } from '../../src/main/pull-requests/provider'
import { rollupChecks, type PrCheck, type PrConversation, type PrDetail, type PrRef } from '../../src/shared/pull-requests'
import { parseHunks } from '../../src/shared/unified-diff'

const GH: PrRef = { host: 'github', owner: 'tejasnafde', name: 'switchboard', number: 161 }
const BB: PrRef = { host: 'bitbucket', owner: 'geoiq', name: 'ssg-bot-v2', number: 612 }

function detail(ref: PrRef, over: Partial<PrDetail> = {}): PrDetail {
  return {
    ref, title: 'Cost cap', url: '', author: { login: 'backend', displayName: 'backend', avatarUrl: null }, state: 'open', draft: false,
    sourceBranch: 'feat/cap', targetBranch: 'main', createdAt: 0, updatedAt: 0, mergedAt: null, additions: null, deletions: null,
    changedFiles: null, unresolvedConversations: 0, mergeConflicts: false, conflictedFiles: [], checks: rollupChecks([]), reviewers: [], approvals: { given: 1, required: 1 },
    viewer: { isAuthor: false, isRequestedReviewer: true, hasReviewed: false, hasCommented: false }, projectPaths: [], description: '', headSha: 'abc1234',
    mergeBlockers: [], mergeStrategies: ['merge_commit', 'squash'], activity: [], checkList: [], viewerCanManage: false, ...over,
  }
}

const thread: PrConversation = { id: 'PRRT_1', path: 'src/a.ts', line: 11, side: 'new', resolved: false, outdated: false, comments: [] }
const failed: PrCheck = { id: 'run:0:unit', name: 'unit', state: 'failure', description: null, url: null, durationMs: null, rerunId: '42' }

function fakeProvider(host: 'github' | 'bitbucket', over: Partial<PrDetail> = {}, checks: PrCheck[] = [failed]) {
  const ref = host === 'github' ? GH : BB
  const writes = {
    reply: vi.fn(), setResolved: vi.fn(), comment: vi.fn(), inlineComment: vi.fn(), submitReview: vi.fn(), merge: vi.fn(), rerunCheck: vi.fn(),
    addReviewer: vi.fn(), removeReviewer: vi.fn(), decline: vi.fn(),
  }
  const provider: PullRequestProvider = {
    host,
    list: vi.fn(async () => []),
    detail: vi.fn(async () => detail(ref, over)),
    files: vi.fn(async () => [{
      path: 'src/a.ts', oldPath: null, status: 'modified', additions: 1, deletions: 0, binary: false, truncated: false,
      hunks: parseHunks('@@ -10,2 +10,3 @@\n ctx\n+added\n ctx2').hunks,
    }]),
    conversations: vi.fn(async () => [thread, { ...thread, id: '812' }]),
    checks: vi.fn(async () => checks),
    reviewerCandidates: vi.fn(async () => []),
    ...writes,
  }
  return { provider, writes }
}

function service(gh: PullRequestProvider, bb?: PullRequestProvider) {
  const remotes: Record<string, string> = {
    '/p/switchboard': 'origin\thttps://github.com/tejasnafde/switchboard.git (fetch)',
    '/p/bot': 'origin\tgit@bitbucket.org:geoiq/ssg-bot-v2.git (fetch)',
  }
  return new PullRequestService({
    listProjects: () => Object.keys(remotes),
    readRemotes: async (p) => remotes[p],
    github: () => gh,
    bitbucket: () => bb ?? fakeProvider('bitbucket').provider,
    bitbucketState: () => ({ state: 'configured', email: 'me@example.com' }),
  })
}

describe('writes: validation before the host', () => {
  it('refuses a repository that is not one of the projects without calling the host', async () => {
    const { provider, writes } = fakeProvider('github')
    const result = await service(provider).comment({ ...GH, owner: 'someone-else' }, { body: 'hi' })
    expect(result).toMatchObject({ ok: false, error: { kind: 'unsupported_repo' } })
    expect(writes.comment).not.toHaveBeenCalled()
  })

  it('refuses bad input as invalid and sends nothing', async () => {
    const { provider, writes } = fakeProvider('github')
    const s = service(provider)
    expect(await s.reply(GH, { conversationId: 'PRRT_1', body: '' })).toMatchObject({ ok: false, error: { kind: 'invalid' } })
    expect(await s.merge(GH, { strategy: 'yolo', expectedHeadSha: 'abc1234' })).toMatchObject({ ok: false, error: { kind: 'invalid' } })
    expect(await s.inlineComment(GH, { path: 'src/a.ts', side: 'new', line: -3, body: 'x' })).toMatchObject({ ok: false, error: { kind: 'invalid' } })
    expect(await s.comment(GH, { body: 'x'.repeat(70_000) })).toMatchObject({ ok: false, error: { kind: 'invalid' } })
    for (const fn of Object.values(writes)) expect(fn).not.toHaveBeenCalled()
  })

  it('names the reads to refresh when a write is done', async () => {
    const { provider, writes } = fakeProvider('github')
    expect(await service(provider).reply(GH, { conversationId: 'PRRT_1', body: ' Fixed. ' })).toEqual({ ok: true, data: { refresh: ['conversations', 'detail'] } })
    expect(writes.reply).toHaveBeenCalledWith(GH, 'PRRT_1', 'Fixed.')
  })
})

describe('writes: checked against a fresh read', () => {
  it('refuses a reply or resolve on a thread that is gone', async () => {
    const { provider, writes } = fakeProvider('github')
    const s = service(provider)
    expect(await s.reply(GH, { conversationId: 'PRRT_gone', body: 'x' })).toMatchObject({ ok: false, error: { kind: 'stale' } })
    expect(await s.setResolved(GH, { conversationId: 'PRRT_gone' }, true)).toMatchObject({ ok: false, error: { kind: 'stale' } })
    expect(await s.setResolved(GH, { conversationId: 'PRRT_1' }, false)).toMatchObject({ ok: true })
    expect(writes.setResolved).toHaveBeenCalledWith(GH, 'PRRT_1', false)
    expect(writes.reply).not.toHaveBeenCalled()
  })

  it('refuses a line comment on a line the diff no longer shows', async () => {
    const { provider, writes } = fakeProvider('github')
    const s = service(provider)
    expect(await s.inlineComment(GH, { path: 'src/a.ts', side: 'new', line: 99, body: 'x' })).toMatchObject({ ok: false, error: { kind: 'stale' } })
    expect(await s.inlineComment(GH, { path: 'src/a.ts', side: 'new', line: 11, body: 'x' })).toMatchObject({ ok: true })
    expect(writes.inlineComment).toHaveBeenCalledTimes(1)
  })

  it('takes a range inside the hunk, and names a range that is no longer shown', async () => {
    const { provider, writes } = fakeProvider('github')
    const s = service(provider)
    expect(await s.inlineComment(GH, { path: 'src/a.ts', side: 'new', line: 12, startLine: 10, body: 'x' })).toMatchObject({ ok: true })
    expect(writes.inlineComment).toHaveBeenCalledWith(GH, expect.objectContaining({ line: 12, startLine: 10 }))
    expect(await s.inlineComment(GH, { path: 'src/a.ts', side: 'new', line: 12, startLine: 4, body: 'x' }))
      .toMatchObject({ ok: false, error: { kind: 'stale', message: 'src/a.ts:4-12 is not in the diff any more.' } })
  })

  it('merges only the head the user confirmed, with no blockers', async () => {
    const moved = fakeProvider('github', { headSha: 'fff0000' })
    expect(await service(moved.provider).merge(GH, { strategy: 'merge_commit', expectedHeadSha: 'abc1234' })).toMatchObject({ ok: false, error: { kind: 'stale' } })
    const blocked = fakeProvider('github', { mergeBlockers: [{ kind: 'changes_requested', label: 'Changes requested' }] })
    expect(await service(blocked.provider).merge(GH, { strategy: 'merge_commit', expectedHeadSha: 'abc1234' })).toMatchObject({ ok: false, error: { kind: 'stale' } })
    const squashOnly = fakeProvider('github', { mergeStrategies: ['squash'] })
    expect(await service(squashOnly.provider).merge(GH, { strategy: 'merge_commit', expectedHeadSha: 'abc1234' })).toMatchObject({ ok: false, error: { kind: 'invalid' } })
    for (const p of [moved, blocked, squashOnly]) expect(p.writes.merge).not.toHaveBeenCalled()

    const ready = fakeProvider('github')
    expect(await service(ready.provider).merge(GH, { strategy: 'merge_commit', expectedHeadSha: 'abc1234' })).toEqual({ ok: true, data: { refresh: ['detail', 'checks'] } })
    expect(ready.writes.merge).toHaveBeenCalledWith(GH, 'merge_commit', 'abc1234')
  })

  it('never lets the author approve or request changes, and lets them comment', async () => {
    const { provider, writes } = fakeProvider('github', { viewer: { isAuthor: true, isRequestedReviewer: false, hasReviewed: false, hasCommented: false } })
    const s = service(provider)
    expect(await s.submitReview(GH, { event: 'approve', body: '', comments: [] })).toMatchObject({ ok: false, error: { kind: 'forbidden' } })
    expect(await s.submitReview(GH, { event: 'request_changes', body: 'No', comments: [] })).toMatchObject({ ok: false, error: { kind: 'forbidden' } })
    expect(writes.submitReview).not.toHaveBeenCalled()
    expect(await s.submitReview(GH, { event: 'comment', body: 'Note to self', comments: [] })).toMatchObject({ ok: true })
  })

  it('refuses a review whose pending comment fell off the diff', async () => {
    const { provider, writes } = fakeProvider('github')
    const result = await service(provider).submitReview(GH, { event: 'approve', body: '', comments: [{ path: 'src/a.ts', side: 'new', line: 500, body: 'x' }] })
    expect(result).toMatchObject({ ok: false, error: { kind: 'stale' } })
    expect(writes.submitReview).not.toHaveBeenCalled()
  })

  it('re-runs only a failed check that can re-run', async () => {
    const gh = fakeProvider('github')
    expect(await service(gh.provider).rerunCheck(GH, { checkId: 'run:0:unit' })).toMatchObject({ ok: true })
    expect(gh.writes.rerunCheck).toHaveBeenCalledWith(GH, failed)
    expect(await service(gh.provider).rerunCheck(GH, { checkId: 'run:9:gone' })).toMatchObject({ ok: false, error: { kind: 'stale' } })

    const green = fakeProvider('github', {}, [{ ...failed, state: 'success' }])
    expect(await service(green.provider).rerunCheck(GH, { checkId: 'run:0:unit' })).toMatchObject({ ok: false, error: { kind: 'stale' } })
    const external = fakeProvider('github', {}, [{ ...failed, rerunId: null }])
    expect(await service(external.provider).rerunCheck(GH, { checkId: 'run:0:unit' })).toMatchObject({ ok: false, error: { kind: 'invalid' } })

    const bb = fakeProvider('bitbucket')
    const result = await service(gh.provider, bb.provider).rerunCheck(BB, { checkId: 'run:0:unit' })
    expect(result).toMatchObject({ ok: false, error: { kind: 'forbidden', host: 'bitbucket' } })
    expect(bb.writes.rerunCheck).not.toHaveBeenCalled()
  })

  it('returns a host refusal as its typed error', async () => {
    const { provider, writes } = fakeProvider('github')
    writes.comment.mockRejectedValue(new PrHostError({ kind: 'rate_limited', host: 'github', message: 'GitHub rate limit reached.' }))
    expect(await service(provider).comment(GH, { body: 'hi' })).toEqual({ ok: false, error: { kind: 'rate_limited', host: 'github', message: 'GitHub rate limit reached.' } })
  })
})

describe('reviewer and decline writes', () => {
  const UUID = '{00000000-0000-4000-8000-00000000000b}'
  const pending = { id: 'pankaj', person: { login: 'pankaj', displayName: 'pankaj', avatarUrl: null }, state: 'pending' as const, requested: true }

  it('adds and removes a reviewer after re-reading the PR, and refreshes the detail', async () => {
    const { provider, writes } = fakeProvider('github', { viewerCanManage: true, reviewers: [pending] })
    const s = service(provider)
    expect(await s.addReviewer(GH, { reviewer: 'akshaya' })).toEqual({ ok: true, data: { refresh: ['detail'] } })
    expect(writes.addReviewer).toHaveBeenCalledWith(GH, 'akshaya')
    expect(await s.removeReviewer(GH, { reviewer: 'pankaj' })).toMatchObject({ ok: true })
    expect(writes.removeReviewer).toHaveBeenCalledWith(GH, 'pankaj')
    expect(provider.detail).toHaveBeenCalledTimes(2)
  })

  it('refuses before the host: bad ids, a viewer the host does not allow, a closed PR', async () => {
    const bb = fakeProvider('bitbucket', { viewerCanManage: true })
    const s = service(fakeProvider('github').provider, bb.provider)
    expect(await s.addReviewer(BB, { reviewer: 'pankaj' })).toMatchObject({ ok: false, error: { kind: 'invalid' } })
    expect(await s.addReviewer(BB, { reviewer: UUID })).toMatchObject({ ok: true })

    const denied = fakeProvider('github')
    expect(await service(denied.provider).addReviewer(GH, { reviewer: 'akshaya' })).toMatchObject({ ok: false, error: { kind: 'forbidden' } })
    expect(await service(denied.provider).decline(GH)).toMatchObject({ ok: false, error: { kind: 'forbidden' } })
    const closed = fakeProvider('github', { viewerCanManage: true, state: 'closed' })
    expect(await service(closed.provider).decline(GH)).toMatchObject({ ok: false, error: { kind: 'stale' } })
    for (const w of [denied.writes, closed.writes]) {
      expect(w.addReviewer).not.toHaveBeenCalled()
      expect(w.decline).not.toHaveBeenCalled()
    }
  })

  it('declines an open PR the viewer may manage', async () => {
    const { provider, writes } = fakeProvider('bitbucket', { viewerCanManage: true })
    expect(await service(fakeProvider('github').provider, provider).decline(BB)).toEqual({ ok: true, data: { refresh: ['detail'] } })
    expect(writes.decline).toHaveBeenCalledWith(BB)
  })

  it('passes a host refusal through as the typed error', async () => {
    const { provider, writes } = fakeProvider('github', { viewerCanManage: true })
    writes.addReviewer.mockRejectedValueOnce(new PrHostError({ kind: 'invalid', host: 'github', message: 'Reviews may only be requested from collaborators.' }))
    expect(await service(provider).addReviewer(GH, { reviewer: 'stranger' })).toMatchObject({ ok: false, error: { kind: 'invalid', message: 'Reviews may only be requested from collaborators.' } })
  })

  it('lists recent reviewers of the repository before its members', async () => {
    const { provider } = fakeProvider('github')
    const reviewed = { ...pending, state: 'approved' as const }
    vi.mocked(provider.list).mockResolvedValueOnce([{ repo: GH, prs: [{ ...detail(GH), reviewers: [reviewed] }], error: null }])
    vi.mocked(provider.reviewerCandidates).mockResolvedValueOnce([
      { id: 'barath', person: { login: 'barath', displayName: 'barath', avatarUrl: null }, kind: 'user', reviewed: 0 },
      { id: 'pankaj', person: { login: 'pankaj', displayName: 'pankaj', avatarUrl: null }, kind: 'user', reviewed: 0 },
    ])
    const result = await service(provider).reviewerCandidates(GH)
    expect(result.ok && result.data.map((c) => [c.id, c.reviewed])).toEqual([['pankaj', 1], ['barath', 0]])
  })
})
