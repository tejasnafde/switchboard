/**
 * GitHub writes against a fake gh: the arguments, the JSON body on stdin
 * (never `-F` fields, which read `@file`), the GraphQL mutations, the
 * pending review that is created and submitted at once, and the typed
 * errors for refused writes. No test reaches a real host.
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('../../src/main/shell-env', () => ({ childProcessEnv: () => ({}) }))

import { GitHubProvider, type GhRunResult } from '../../src/main/pull-requests/github'
import { actionsRunId, classifyGhWriteError } from '../../src/main/pull-requests/github-map'
import { PrHostError } from '../../src/main/pull-requests/provider'
import type { PrCheck, PrRef } from '../../src/shared/pull-requests'

const ref: PrRef = { host: 'github', owner: 'tejasnafde', name: 'switchboard', number: 161 }
const ok = (stdout = ''): GhRunResult => ({ stdout, stderr: '', code: 0 })

interface Call {
  args: string[]
  body: unknown
}

function fakeGh(answers: GhRunResult[] = []) {
  const calls: Call[] = []
  const run = vi.fn(async (args: string[], opts: { input?: string } = {}) => {
    calls.push({ args, body: opts.input === undefined ? undefined : JSON.parse(opts.input) })
    return answers.shift() ?? ok()
  })
  return { provider: new GitHubProvider(run), calls }
}

const check = (over: Partial<PrCheck> = {}): PrCheck => ({
  id: 'run:0:unit',
  name: 'unit',
  state: 'failure',
  description: null,
  url: null,
  durationMs: null,
  rerunId: '36317659179',
  ...over,
})

describe('GitHub write requests', () => {
  it('replies to a thread with the addPullRequestReviewThreadReply mutation', async () => {
    const { provider, calls } = fakeGh()
    await provider.reply(ref, 'PRRT_kwDO1', '@here: fixed in a1b2c3d')
    expect(calls[0].args).toEqual(['api', 'graphql', '--input', '-'])
    const body = calls[0].body as { query: string; variables: Record<string, string> }
    expect(body.query).toContain(
      'addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body })',
    )
    // The body travels as a variable, so a leading @ is text, not a file name.
    expect(body.variables).toEqual({ thread: 'PRRT_kwDO1', body: '@here: fixed in a1b2c3d' })
  })

  it('resolves and unresolves with their own mutations', async () => {
    const { provider, calls } = fakeGh()
    await provider.setResolved(ref, 'PRRT_1', true)
    await provider.setResolved(ref, 'PRRT_1', false)
    const [a, b] = calls.map((c) => c.body as { query: string; variables: object })
    expect(a.query).toContain('resolveReviewThread(input: { threadId: $thread })')
    expect(b.query).toContain('unresolveReviewThread(input: { threadId: $thread })')
    expect(a.variables).toEqual({ thread: 'PRRT_1' })
  })

  it('posts a comment on the whole PR to the issue comments endpoint', async () => {
    const { provider, calls } = fakeGh()
    await provider.comment(ref, 'Looks good')
    expect(calls[0]).toEqual({
      args: ['api', '--method', 'POST', 'repos/tejasnafde/switchboard/issues/161/comments', '--input', '-'],
      body: { body: 'Looks good' },
    })
  })

  it('posts a line comment on the head commit, old side and ranges included', async () => {
    const { provider, calls } = fakeGh([
      ok(JSON.stringify({ data: { repository: { pullRequest: { headRefOid: 'aa11bb22' } } } })),
      ok('{}'),
    ])
    await provider.inlineComment(ref, {
      path: 'src/a.ts',
      side: 'old',
      line: 12,
      startLine: 10,
      body: 'Why remove this?',
    })
    expect(calls[0].args.slice(0, 2)).toEqual(['api', 'graphql'])
    expect(calls[1]).toEqual({
      args: ['api', '--method', 'POST', 'repos/tejasnafde/switchboard/pulls/161/comments', '--input', '-'],
      body: {
        commit_id: 'aa11bb22',
        path: 'src/a.ts',
        line: 12,
        side: 'LEFT',
        start_line: 10,
        start_side: 'LEFT',
        body: 'Why remove this?',
      },
    })
  })

  it('submits a review with pending comments (a range included) as one pending review, then its event', async () => {
    const { provider, calls } = fakeGh([ok(JSON.stringify({ id: 555, state: 'PENDING' })), ok('{}')])
    await provider.submitReview(ref, {
      event: 'request_changes',
      body: 'Two things.',
      comments: [
        { path: 'src/a.ts', side: 'new', line: 88, startLine: 80, body: 'Cap of 0?' },
        { path: 'src/b.ts', side: 'new', line: 5, body: 'Negative?' },
      ],
    })
    expect(calls[0]).toEqual({
      args: ['api', '--method', 'POST', 'repos/tejasnafde/switchboard/pulls/161/reviews', '--input', '-'],
      body: {
        comments: [
          { path: 'src/a.ts', line: 88, side: 'RIGHT', start_line: 80, start_side: 'RIGHT', body: 'Cap of 0?' },
          { path: 'src/b.ts', line: 5, side: 'RIGHT', body: 'Negative?' },
        ],
      },
    })
    expect(calls[1]).toEqual({
      args: ['api', '--method', 'POST', 'repos/tejasnafde/switchboard/pulls/161/reviews/555/events', '--input', '-'],
      body: { event: 'REQUEST_CHANGES', body: 'Two things.' },
    })
  })

  it('sends a review without comments in one call', async () => {
    const { provider, calls } = fakeGh()
    await provider.submitReview(ref, { event: 'approve', body: '', comments: [] })
    expect(calls).toEqual([
      {
        args: ['api', '--method', 'POST', 'repos/tejasnafde/switchboard/pulls/161/reviews', '--input', '-'],
        body: { event: 'APPROVE', body: '' },
      },
    ])
  })

  it('deletes the pending review when submitting it fails, and reports the failure', async () => {
    const refused: GhRunResult = {
      code: 1,
      stdout: '{"message":"Resource not accessible by integration"}',
      stderr: 'gh: Resource not accessible by integration (HTTP 403)',
    }
    const { provider, calls } = fakeGh([ok('{"id":556}'), refused, ok('')])
    await expect(
      provider.submitReview(ref, {
        event: 'comment',
        body: '',
        comments: [{ path: 'a', side: 'new', line: 1, body: 'x' }],
      }),
    ).rejects.toMatchObject({ error: { kind: 'forbidden' } })
    expect(calls[2].args).toEqual(['api', '--method', 'DELETE', 'repos/tejasnafde/switchboard/pulls/161/reviews/556'])
  })

  it('merges with the chosen method and the confirmed head', async () => {
    const { provider, calls } = fakeGh()
    await provider.merge(ref, 'merge_commit', 'aa11bb22')
    await provider.merge(ref, 'squash', 'aa11bb22')
    expect(calls[0]).toEqual({
      args: ['api', '--method', 'PUT', 'repos/tejasnafde/switchboard/pulls/161/merge', '--input', '-'],
      body: { merge_method: 'merge', sha: 'aa11bb22' },
    })
    expect(calls[1].body).toEqual({ merge_method: 'squash', sha: 'aa11bb22' })
  })

  it('refuses a strategy GitHub does not have without calling gh', async () => {
    const { provider, calls } = fakeGh()
    await expect(provider.merge(ref, 'fast_forward', 'aa11bb22')).rejects.toBeInstanceOf(PrHostError)
    expect(calls).toHaveLength(0)
  })

  it('re-runs the failed jobs of an Actions run', async () => {
    const { provider, calls } = fakeGh()
    await provider.rerunCheck(ref, check())
    expect(calls[0]).toEqual({
      args: ['api', '--method', 'POST', 'repos/tejasnafde/switchboard/actions/runs/36317659179/rerun-failed-jobs'],
      body: undefined,
    })
    await expect(provider.rerunCheck(ref, check({ rerunId: null }))).rejects.toMatchObject({
      error: { kind: 'invalid' },
    })
    await expect(provider.rerunCheck(ref, check({ rerunId: '1;rm' }))).rejects.toMatchObject({
      error: { kind: 'invalid' },
    })
    expect(calls).toHaveLength(1)
  })
})

describe('GitHub reviewer and close requests', () => {
  const pulls = 'repos/tejasnafde/switchboard/pulls/161'

  it('requests and removes a person in reviewers and a team in team_reviewers', async () => {
    const { provider, calls } = fakeGh()
    await provider.addReviewer(ref, 'pankaj')
    await provider.addReviewer(ref, 'team:core')
    await provider.removeReviewer(ref, 'pankaj')
    expect(calls).toEqual([
      {
        args: ['api', '--method', 'POST', `${pulls}/requested_reviewers`, '--input', '-'],
        body: { reviewers: ['pankaj'] },
      },
      {
        args: ['api', '--method', 'POST', `${pulls}/requested_reviewers`, '--input', '-'],
        body: { team_reviewers: ['core'] },
      },
      {
        args: ['api', '--method', 'DELETE', `${pulls}/requested_reviewers`, '--input', '-'],
        body: { reviewers: ['pankaj'] },
      },
    ])
  })

  it('closes with a PATCH to state closed', async () => {
    const { provider, calls } = fakeGh()
    await provider.decline(ref)
    expect(calls).toEqual([{ args: ['api', '--method', 'PATCH', pulls, '--input', '-'], body: { state: 'closed' } }])
  })

  it('offers collaborators and teams, and none of a list the token may not read', async () => {
    const { provider, calls } = fakeGh([
      ok(JSON.stringify([{ login: 'pankaj', avatar_url: null }])),
      { stdout: '{"message":"Not Found"}', stderr: 'gh: Not Found (HTTP 404)\n', code: 1 },
    ])
    const candidates = await provider.reviewerCandidates({ host: 'github', owner: 'tejasnafde', name: 'switchboard' })
    expect(calls.map((c) => c.args[1])).toEqual([
      'repos/tejasnafde/switchboard/collaborators?per_page=100',
      'repos/tejasnafde/switchboard/teams?per_page=100',
    ])
    expect(candidates).toEqual([
      { id: 'pankaj', person: { login: 'pankaj', displayName: 'pankaj', avatarUrl: null }, kind: 'user', reviewed: 0 },
    ])
  })

  it('still says so when gh is signed out', async () => {
    const out = { stdout: '', stderr: 'gh: Bad credentials (HTTP 401)\n', code: 1 }
    const { provider } = fakeGh([out, out])
    await expect(provider.reviewerCandidates({ host: 'github', owner: 'o', name: 'r' })).rejects.toMatchObject({
      error: { kind: 'token_rejected' },
    })
  })
})

describe('actionsRunId', () => {
  it('reads the run id from an Actions job link and nothing else', () => {
    expect(actionsRunId('https://github.com/tejasnafde/switchboard/actions/runs/36317659179/job/108615304998')).toBe(
      '36317659179',
    )
    expect(actionsRunId('https://github.com/x/y/actions/runs/3')).toBe('3')
    expect(actionsRunId('https://ci.example.com/actions/runs/3')).toBeNull()
    expect(actionsRunId('https://github.com/x/y/runs/3')).toBeNull()
    expect(actionsRunId(null)).toBeNull()
  })
})

describe('classifyGhWriteError', () => {
  const { cases } = JSON.parse(
    readFileSync(join(__dirname, '../fixtures/pull-requests/github-write-errors.json'), 'utf8'),
  ) as {
    cases: Array<{ name: string; code: number; stdout: string; stderr: string; kind: string; message: string }>
  }
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(classifyGhWriteError(c)).toEqual({ kind: c.kind, host: 'github', message: c.message })
  })

  it('turns a refused write into a thrown typed error', async () => {
    const conflict = cases.find((c) => c.kind === 'stale')!
    const { provider } = fakeGh([conflict])
    await expect(provider.merge(ref, 'merge_commit', 'aa11bb22')).rejects.toMatchObject({
      error: { kind: 'stale', host: 'github' },
    })
  })
})
