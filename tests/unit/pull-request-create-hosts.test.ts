/**
 * Opening a pull request, for create_pull_request: the GitHub (fake gh) and
 * Bitbucket (fake fetch) requests, their error mapping (a token without the
 * write scope says so), and the service, which validates again, refuses a
 * repository none of the projects points at, and returns an open PR for the
 * branch instead of opening a second. No test reaches a real host.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/logger', () => ({ createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))
vi.mock('../../src/main/shell-env', () => ({ childProcessEnv: () => ({}) }))

import { GitHubProvider, type GhRunResult } from '../../src/main/pull-requests/github'
import { BITBUCKET_API, BitbucketClient, BitbucketProvider, type FetchLike } from '../../src/main/pull-requests/bitbucket'
import { PrHostError, type PullRequestProvider } from '../../src/main/pull-requests/provider'
import { PullRequestService } from '../../src/main/pull-requests/service'
import type { CreatePrInput } from '../../src/shared/agent-pr-create'
import type { RepoRef } from '../../src/shared/pull-requests'

const APP: RepoRef = { host: 'github', owner: 'acme', name: 'app' }
const BOT: RepoRef = { host: 'bitbucket', owner: 'geoiq', name: 'ssg-bot-v2' }
const input: CreatePrInput = { title: 'Backoff', description: 'Adds jitter.\n\nvia Switchboard', sourceBranch: 'feat/x', targetBranch: 'main', draft: false }

function fakeGh(answers: GhRunResult[] = []) {
  const calls: Array<{ args: string[]; body: unknown }> = []
  const run = vi.fn(async (args: string[], opts: { input?: string } = {}) => {
    calls.push({ args, body: opts.input === undefined ? undefined : JSON.parse(opts.input) })
    return answers.shift() ?? { stdout: '', stderr: '', code: 0 }
  })
  return { provider: new GitHubProvider(run, 0), calls }
}

describe('GitHub', () => {
  it('opens a pull request with POST pulls, the body on stdin', async () => {
    const { provider, calls } = fakeGh([{ stdout: JSON.stringify({ number: 190, html_url: 'https://github.com/acme/app/pull/190' }), stderr: '', code: 0 }])
    expect(await provider.createPullRequest(APP, { ...input, draft: true })).toEqual({ number: 190, url: 'https://github.com/acme/app/pull/190' })
    expect(calls[0].args).toEqual(['api', '--method', 'POST', 'repos/acme/app/pulls', '--input', '-'])
    expect(calls[0].body).toEqual({ title: 'Backoff', body: 'Adds jitter.\n\nvia Switchboard', head: 'feat/x', base: 'main', draft: true })
  })

  it('reads the default branch, and the open PR whose head is this repository, not a same-owner fork', async () => {
    const { provider, calls } = fakeGh([
      { stdout: 'main\n', stderr: '', code: 0 },
      { stdout: JSON.stringify([
        // A fork under the same owner with another name matches head=acme:feat/x too.
        { number: 8, html_url: 'https://github.com/acme/app/pull/8', head: { repo: { full_name: 'acme/app-fork' } } },
        { number: 7, html_url: 'https://github.com/acme/app/pull/7', head: { repo: { full_name: 'ACME/app' } } },
      ]), stderr: '', code: 0 },
      { stdout: JSON.stringify([{ number: 9, html_url: 'u9', head: { repo: null } }, { number: 10, html_url: 'u10', head: { repo: { full_name: 'acme/app-fork' } } }]), stderr: '', code: 0 },
      { stdout: '[]', stderr: '', code: 0 },
    ])
    expect(await provider.defaultBranch(APP)).toBe('main')
    expect(await provider.openPullRequestFor(APP, 'feat/x')).toEqual({ number: 7, url: 'https://github.com/acme/app/pull/7' })
    // Only a fork's PR, or one whose head repository was deleted: none of this repository.
    expect(await provider.openPullRequestFor(APP, 'feat/x')).toBeNull()
    expect(await provider.openPullRequestFor(APP, 'feat/y')).toBeNull()
    expect(calls[0].args).toEqual(['api', 'repos/acme/app', '--jq', '.default_branch'])
    expect(calls[1].args).toEqual(['api', 'repos/acme/app/pulls?state=open&per_page=30&head=acme%3Afeat%2Fx'])
  })

  it('says which scope a token without write access needs', async () => {
    const { provider } = fakeGh([{ stdout: JSON.stringify({ message: 'Resource not accessible by personal access token' }), stderr: 'gh: Resource not accessible by personal access token (HTTP 403)', code: 1 }])
    const err = await provider.createPullRequest(APP, input).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PrHostError)
    expect((err as PrHostError).error.kind).toBe('forbidden')
    expect((err as PrHostError).error.message).toContain('Resource not accessible by personal access token')
    expect((err as PrHostError).error.message).toContain('the repo scope for a classic token')
  })

  it("passes GitHub's own reason for a refused input on", async () => {
    const { provider } = fakeGh([{ stdout: JSON.stringify({ message: 'Validation Failed', errors: [{ message: 'No commits between main and feat/x' }] }), stderr: 'gh: Validation Failed (HTTP 422)', code: 1 }])
    const err = (await provider.createPullRequest(APP, input).catch((e: unknown) => e)) as PrHostError
    expect(err.error.kind).toBe('invalid')
  })

  it('asks the reviewers in one requested_reviewers call after the create, teams apart', async () => {
    const { provider, calls } = fakeGh([
      { stdout: JSON.stringify({ number: 190, html_url: 'https://github.com/acme/app/pull/190' }), stderr: '', code: 0 },
      { stdout: '{}', stderr: '', code: 0 },
    ])
    expect(await provider.createPullRequest(APP, { ...input, reviewers: ['jdoe', 'team:platform', 'rahul'] })).toEqual({ number: 190, url: 'https://github.com/acme/app/pull/190' })
    expect(calls[0].body).not.toHaveProperty('reviewers')
    expect(calls[1].args).toEqual(['api', '--method', 'POST', 'repos/acme/app/pulls/190/requested_reviewers', '--input', '-'])
    expect(calls[1].body).toEqual({ reviewers: ['jdoe', 'rahul'], team_reviewers: ['platform'] })
  })

  it('keeps the opened PR and reports the reviewers when the second call fails, never sending the create again', async () => {
    const { provider, calls } = fakeGh([
      { stdout: JSON.stringify({ number: 190, html_url: 'https://github.com/acme/app/pull/190' }), stderr: '', code: 0 },
      { stdout: JSON.stringify({ message: 'Reviews may only be requested from collaborators.' }), stderr: 'gh: Reviews may only be requested from collaborators. (HTTP 422)', code: 1 },
    ])
    const opened = await provider.createPullRequest(APP, { ...input, reviewers: ['stranger'] })
    expect(opened).toMatchObject({ number: 190, url: 'https://github.com/acme/app/pull/190', reviewerFailure: { reviewers: ['stranger'], error: { kind: 'invalid' } } })
    expect(calls).toHaveLength(2)
    expect(calls.filter((c) => c.args[3] === 'repos/acme/app/pulls')).toHaveLength(1)
  })

  it('never retries the write itself', async () => {
    const { provider, calls } = fakeGh([{ stdout: '', stderr: 'gh: Bad gateway (HTTP 502)', code: 1 }])
    await expect(provider.createPullRequest(APP, input)).rejects.toBeInstanceOf(PrHostError)
    expect(calls).toHaveLength(1)
  })
})

interface Answer { status: number; body?: unknown }

function fakeFetch(answers: Answer[] = []) {
  const sent: Array<{ method: string; url: string; body: unknown }> = []
  const impl: FetchLike = vi.fn(async (url, init) => {
    sent.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(init.body) : undefined })
    const a = answers.shift() ?? { status: 200, body: {} }
    const text = a.body === undefined ? '' : JSON.stringify(a.body)
    return { ok: a.status >= 200 && a.status < 300, status: a.status, headers: { get: () => null }, json: async () => a.body, text: async () => text }
  })
  return { provider: new BitbucketProvider(new BitbucketClient({ email: 'me@example.com', apiToken: 'tok' }, impl)), sent }
}

const BB_REPO = `${BITBUCKET_API}/repositories/geoiq/ssg-bot-v2`

describe('Bitbucket', () => {
  it('opens a pull request with source and destination branches', async () => {
    const { provider, sent } = fakeFetch([{ status: 201, body: { id: 613, links: { html: { href: 'https://bitbucket.org/geoiq/ssg-bot-v2/pull-requests/613' } } } }])
    expect(await provider.createPullRequest(BOT, input)).toEqual({ number: 613, url: 'https://bitbucket.org/geoiq/ssg-bot-v2/pull-requests/613' })
    expect(sent).toEqual([{
      method: 'POST',
      url: `${BB_REPO}/pullrequests`,
      body: { title: 'Backoff', description: 'Adds jitter.\n\nvia Switchboard', source: { branch: { name: 'feat/x' } }, destination: { branch: { name: 'main' } } },
    }])
  })

  it('asks the reviewers in the same POST, by account uuid', async () => {
    const { provider, sent } = fakeFetch([{ status: 201, body: { id: 613, links: { html: { href: 'https://bitbucket.org/geoiq/ssg-bot-v2/pull-requests/613' } } } }])
    const uuid = '{00000000-0000-4000-8000-000000000002}'
    await provider.createPullRequest(BOT, { ...input, reviewers: [uuid] })
    expect(sent).toHaveLength(1)
    expect(sent[0].body).toMatchObject({ reviewers: [{ uuid }] })
  })

  it('says the API token is missing write:pullrequest when Bitbucket names the scope', async () => {
    const { provider } = fakeFetch([{
      status: 403,
      body: { type: 'error', error: { message: 'Your credentials lack one or more required privilege scopes.', detail: { granted: ['read:pullrequest:bitbucket'], required: ['write:pullrequest:bitbucket'] } } },
    }])
    const err = (await provider.createPullRequest(BOT, input).catch((e: unknown) => e)) as PrHostError
    expect(err.error.kind).toBe('forbidden')
    expect(err.error.message).toBe('The Bitbucket API token is missing the write:pullrequest:bitbucket scope. Create a token that has it and save it in Settings > Accounts & models > Source control.')
    expect(err.error.message).not.toContain('[object Object]')
  })

  it('reads the main branch, and finds an open PR of this repository for the branch, not a fork', async () => {
    const own = { id: 612, links: { html: { href: 'https://bitbucket.org/geoiq/ssg-bot-v2/pull-requests/612' } }, source: { repository: { full_name: 'geoiq/ssg-bot-v2' } } }
    const fork = { id: 700, links: { html: { href: 'https://bitbucket.org/geoiq/ssg-bot-v2/pull-requests/700' } }, source: { repository: { full_name: 'someone/ssg-bot-v2' } } }
    const { provider, sent } = fakeFetch([
      { status: 200, body: { mainbranch: { name: 'develop' } } },
      { status: 200, body: { values: [fork, own] } },
      { status: 200, body: { values: [fork] } },
    ])
    expect(await provider.defaultBranch(BOT)).toBe('develop')
    expect(await provider.openPullRequestFor(BOT, 'feat/"x"')).toEqual({ number: 612, url: 'https://bitbucket.org/geoiq/ssg-bot-v2/pull-requests/612' })
    expect(await provider.openPullRequestFor(BOT, 'feat/x')).toBeNull()
    expect(sent[0].url).toBe(`${BB_REPO}?fields=mainbranch.name`)
    expect(decodeURIComponent(sent[1].url)).toContain('q=source.branch.name="feat/\\"x\\"" AND state="OPEN"')
  })
})

function service(provider: Partial<PullRequestProvider>) {
  const p = { host: 'github', ...provider } as PullRequestProvider
  return new PullRequestService({
    listProjects: () => ['/p/app'],
    readRemotes: async () => 'origin\tgit@github.com:acme/app.git (fetch)',
    github: () => p,
    bitbucket: () => null,
    bitbucketState: () => ({ state: 'unconfigured' }),
  })
}

describe('PullRequestService.createPullRequest', () => {
  it('opens one when none is open for the branch', async () => {
    const createPullRequest = vi.fn(async () => ({ number: 5, url: 'u' }))
    const result = await service({ openPullRequestFor: vi.fn(async () => null), createPullRequest }).createPullRequest(APP, input)
    expect(result).toEqual({ ok: true, data: { number: 5, url: 'u', existing: false } })
    expect(createPullRequest).toHaveBeenCalledWith(APP, input)
  })

  it('returns the open one instead of opening a second', async () => {
    const createPullRequest = vi.fn()
    const result = await service({ openPullRequestFor: vi.fn(async () => ({ number: 7, url: 'u7' })), createPullRequest }).createPullRequest(APP, input)
    expect(result).toEqual({ ok: true, data: { number: 7, url: 'u7', existing: true } })
    expect(createPullRequest).not.toHaveBeenCalled()
  })

  it('refuses a repository none of the projects points at, and bad input, before the host', async () => {
    const createPullRequest = vi.fn()
    const openPullRequestFor = vi.fn()
    const s = service({ openPullRequestFor, createPullRequest })
    const other = await s.createPullRequest({ ...APP, owner: 'someone' }, input)
    expect(other.ok ? null : other.error.kind).toBe('unsupported_repo')
    for (const bad of [{ ...input, sourceBranch: '-x' }, { ...input, targetBranch: 'feat/x' }, { ...input, title: ' ' }, { ...input, description: 1 }]) {
      const r = await s.createPullRequest(APP, bad)
      expect(r.ok ? null : r.error.kind).toBe('invalid')
    }
    expect(openPullRequestFor).not.toHaveBeenCalled()
    expect(createPullRequest).not.toHaveBeenCalled()
  })

  it('passes reviewer ids on, and refuses ones that are not this host\'s before the host', async () => {
    const createPullRequest = vi.fn(async () => ({ number: 5, url: 'u' }))
    const s = service({ openPullRequestFor: vi.fn(async () => null), createPullRequest })
    await s.createPullRequest(APP, { ...input, reviewers: ['jdoe', 'team:platform'] })
    expect(createPullRequest).toHaveBeenCalledWith(APP, { ...input, reviewers: ['jdoe', 'team:platform'] })
    for (const reviewers of [['-x'], ['jdoe', 'jdoe'], Array.from({ length: 11 }, (_, i) => `r${i}`), 'jdoe']) {
      const r = await s.createPullRequest(APP, { ...input, reviewers })
      expect(r.ok ? null : r.error.kind).toBe('invalid')
    }
    expect(createPullRequest).toHaveBeenCalledTimes(1)
  })

  it('returns who may review a new PR, recent reviewers first, with the signed-in user', async () => {
    const member = { id: 'rahul', person: { login: 'rahul', displayName: 'rahul', avatarUrl: null }, kind: 'user' as const, reviewed: 0 }
    const s = service({
      list: vi.fn(async () => [{ repo: APP, error: null, prs: [{ reviewers: [{ id: 'jdoe', person: { login: 'jdoe', displayName: 'Jane', avatarUrl: null }, state: 'approved' as const, requested: true }] }] }]) as unknown as PullRequestProvider['list'],
      reviewerCandidates: vi.fn(async () => [member]),
      viewerIdentity: vi.fn(async () => ({ id: 'me', login: 'me' })),
    })
    const pool = await s.reviewerPool(APP)
    expect(pool.ok && pool.data.candidates.map((c) => c.id)).toEqual(['jdoe', 'rahul'])
    expect(pool.ok && pool.data.viewer).toEqual({ id: 'me', login: 'me' })
    const other = await s.reviewerPool({ ...APP, owner: 'someone' })
    expect(other.ok ? null : other.error.kind).toBe('unsupported_repo')
  })

  it('refuses a Bitbucket draft', async () => {
    const createPullRequest = vi.fn()
    const s = new PullRequestService({
      listProjects: () => ['/p/bot'],
      readRemotes: async () => 'origin\tgit@bitbucket.org:geoiq/ssg-bot-v2.git (fetch)',
      github: () => ({ host: 'github' }) as PullRequestProvider,
      bitbucket: () => ({ host: 'bitbucket', openPullRequestFor: vi.fn(async () => null), createPullRequest }) as unknown as PullRequestProvider,
      bitbucketState: () => ({ state: 'configured', email: 'me@example.com' }),
    })
    const r = await s.createPullRequest(BOT, { ...input, draft: true })
    expect(r.ok ? null : r.error.message).toMatch(/cannot open a draft/)
    expect(createPullRequest).not.toHaveBeenCalled()
  })
})
