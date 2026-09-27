/**
 * GitHub JSON -> neutral pull request types, from recorded `gh api graphql`
 * and `gh api .../files` responses (hand-trimmed from a real read of
 * tejasnafde/switchboard). No network: the provider runs on a fake gh.
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('../../src/main/logger', () => ({ createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))
vi.mock('../../src/main/shell-env', () => ({ childProcessEnv: () => process.env }))

import { classifyGhError, mapGhDetail, mapGhFiles, mapGhSummary, mapGhThreads } from '../../src/main/pull-requests/github-map'
import { buildListQuery, GitHubProvider, type GhRunner } from '../../src/main/pull-requests/github'
import { PrHostError } from '../../src/main/pull-requests/provider'
import type { RepoRef } from '../../src/shared/pull-requests'

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, '../fixtures/pull-requests', name), 'utf8'))
const repo: RepoRef = { host: 'github', owner: 'tejasnafde', name: 'switchboard' }
const list = fixture('github-list.json')

describe('mapGhSummary', () => {
  const [review, mine] = list.data.r0.open.nodes

  it('marks a PR you were asked to review, and ignores team requests', () => {
    const pr = mapGhSummary(repo, review, 'tejasnafde')
    expect(pr.viewer).toEqual({ isAuthor: false, isRequestedReviewer: true, hasReviewed: false })
    expect(pr.reviewers.map((r) => [r.person.login, r.state, r.requested])).toEqual([
      ['pankaj', 'commented', false],
      ['tejasnafde', 'pending', true],
    ])
    expect(pr.approvals).toEqual({ given: 0, required: 1 })
    expect(pr.unresolvedConversations).toBe(2)
    expect(pr.checks).toEqual({ state: 'success', total: 2, passed: 2, failed: 0, pending: 0 })
    expect(pr.ref).toEqual({ ...repo, number: 161 })
    expect(pr.author.displayName).toBe('Backend Dev')
    expect(pr.createdAt).toBe(Date.parse('2026-09-27T09:00:00Z'))
  })

  it('matches the viewer case-insensitively and rolls failed and running checks up', () => {
    const pr = mapGhSummary(repo, mine, 'tejasnafde')
    expect(pr.viewer.isAuthor).toBe(true)
    // A timed-out run is a failure; failure outranks the one still running.
    expect(pr.checks).toEqual({ state: 'failure', total: 3, passed: 1, failed: 1, pending: 1 })
    expect(pr.approvals.required).toBeNull()
  })

  it('maps a merged PR with no status rollup', () => {
    const pr = mapGhSummary(repo, list.data.r0.merged.nodes[0], 'tejasnafde')
    expect(pr.state).toBe('merged')
    expect(pr.mergedAt).toBe(Date.parse('2026-09-27T01:02:26Z'))
    expect(pr.checks.state).toBe('none')
    expect(pr.approvals).toEqual({ given: 1, required: 0 })
  })
})

describe('mapGhDetail', () => {
  const detail = mapGhDetail(repo, fixture('github-detail.json').data.repository.pullRequest, 'tejasnafde')

  it('strips HTML comments from the description', () => {
    expect(detail.description).toBe('Resumes from the last seq.\n\nTested on geoiq-ssg-dev-in.')
  })

  it('lists what blocks the merge, conflicts included', () => {
    expect(detail.mergeBlockers.map((b) => b.label)).toEqual([
      'Merge conflicts',
      '1 check failed',
      '1 unresolved conversation',
      'Changes requested',
      '1 of 2 required approvals',
    ])
  })

  it('folds consecutive commits and skips a pending review in the activity feed', () => {
    expect(detail.activity.map((a) => `${a.actor?.login} ${a.summary}${a.detail ? ` | ${a.detail}` : ''}`)).toEqual([
      'tejasnafde pushed 2 commits | Replay from seq',
      'akshaya approved',
      'backend requested changes | 2 comments',
      'pankaj commented | Looks close. One more thing.',
    ])
  })

  it('keeps the check list with durations', () => {
    expect(detail.checkList).toEqual([
      { id: 'run:0:Test (macos-14)', name: 'Test (macos-14)', state: 'failure', description: null, url: 'https://github.com/x/y/actions/runs/3', durationMs: 120_000 },
    ])
    expect(detail.headSha).toBe('aa11bb22cc33')
  })
})

describe('mapGhThreads', () => {
  const threads = mapGhThreads(fixture('github-threads.json').data.repository.pullRequest.reviewThreads.nodes)

  it('anchors a live thread to its line on the new side', () => {
    expect(threads[0]).toMatchObject({ id: 'PRRT_1', path: 'src/shared/iap-tunnel.ts', line: 88, side: 'new', resolved: false, outdated: false })
    expect(threads[0].comments.map((c) => [c.author.login, c.body])).toEqual([
      ['backend', 'A cap of 0 reads as no cap here.'],
      ['ghost', 'Fixed.'],
    ])
  })

  it('drops the line of an outdated thread and keeps its side', () => {
    expect(threads[1]).toMatchObject({ line: null, side: 'old', resolved: true, outdated: true })
  })
})

describe('mapGhFiles', () => {
  const files = mapGhFiles(fixture('github-files.json'))

  it('numbers hunk lines from the header and skips the no-newline marker', () => {
    expect(files[0].hunks).toHaveLength(1)
    expect(files[0].hunks[0].lines.map((l) => [l.kind, l.oldLine, l.newLine, l.text])).toEqual([
      ['context', 10, 10, 'const a = 1'],
      ['del', 11, null, 'const b = 2'],
      ['add', null, 11, 'const b = 3'],
      ['add', null, 12, 'const c = 4'],
      ['context', 12, 13, 'const d = 5'],
    ])
  })

  it('tells binary, renamed and too-large files apart', () => {
    expect(files[2]).toMatchObject({ path: 'assets/logo.png', binary: true, truncated: false })
    expect(files[3]).toMatchObject({ path: 'src/main/renamed.ts', oldPath: 'src/main/old.ts', status: 'renamed', binary: false })
    expect(files[4]).toMatchObject({ path: 'package-lock.json', binary: false, truncated: true, hunks: [] })
  })
})

describe('classifyGhError', () => {
  it.each([
    [{ code: 'ENOENT' }, 'gh_missing'],
    [{ code: 1, stderr: 'To get started with GitHub CLI, please run:  gh auth login' }, 'token_rejected'],
    [{ code: 1, stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)' }, 'rate_limited'],
    [{ code: 1, stderr: 'error connecting to api.github.com' }, 'offline'],
    [{ code: 1, stderr: 'GraphQL: Could not resolve to a Repository with the name' }, 'not_found'],
    [{ code: 1, stderr: 'something odd\nmore' }, 'unknown'],
  ])('%j -> %s', (err, kind) => {
    expect(classifyGhError(err).kind).toBe(kind)
  })
})

describe('GitHubProvider', () => {
  const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 })

  it('reads many repositories in one query and reports the missing one on its own', async () => {
    const calls: string[][] = []
    const run: GhRunner = async (args) => {
      calls.push(args)
      return { stdout: JSON.stringify(list), stderr: 'GraphQL: Could not resolve', code: 1 }
    }
    const results = await new GitHubProvider(run).list([repo, { host: 'github', owner: 'tejasnafde', name: 'gone' }])
    expect(calls).toHaveLength(1)
    expect(calls[0].slice(0, 2)).toEqual(['api', 'graphql'])
    expect(results[0].error).toBeNull()
    expect(results[0].prs.map((p) => p.ref.number)).toEqual([161, 162, 159])
    expect(results[1]).toMatchObject({ prs: [], error: { kind: 'not_found' } })
  })

  it('quotes owner and name as GraphQL strings', () => {
    const q = buildListQuery([repo])
    expect(q).toContain('r0: repository(owner: "tejasnafde", name: "switchboard")')
    expect(q).toContain('fragment Pr on PullRequest')
  })

  it('throws a classified error when gh fails without data', async () => {
    const run: GhRunner = async () => ({ stdout: '', stderr: 'gh auth login', code: 4 })
    await expect(new GitHubProvider(run).list([repo])).rejects.toBeInstanceOf(PrHostError)
    await expect(new GitHubProvider(run).viewerLogin()).rejects.toMatchObject({ error: { kind: 'token_rejected' } })
  })

  it('pages changed files until a short page', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts`, status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+x' }))
    const run = vi.fn<GhRunner>()
      .mockResolvedValueOnce(ok(JSON.stringify(page)))
      .mockResolvedValueOnce(ok(JSON.stringify(page.slice(0, 3))))
    const files = await new GitHubProvider(run).files({ ...repo, number: 5 })
    expect(files).toHaveLength(103)
    expect(run.mock.calls[1][0]).toEqual(['api', 'repos/tejasnafde/switchboard/pulls/5/files?per_page=100&page=2'])
  })

  it('never asks gh for its token', async () => {
    const run = vi.fn<GhRunner>().mockResolvedValue(ok('tejasnafde\n'))
    expect(await new GitHubProvider(run).viewerLogin()).toBe('tejasnafde')
    for (const [args] of run.mock.calls) expect(args.join(' ')).not.toMatch(/auth token|auth status/)
  })
})
