/**
 * Bitbucket Cloud REST 2.0 JSON -> neutral pull request types, from fixtures
 * hand-written against the public API reference (pullrequests, diffstat,
 * diff, comments, activity, commit statuses). No network: the client runs on
 * a fake fetch that serves the fixtures by path.
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('../../src/main/logger', () => ({ createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))

import {
  mapBbActivity,
  mapBbComments,
  mapBbDetail,
  mapBbFiles,
  mapBbStatuses,
  mapBbSummary,
  type BbViewer,
} from '../../src/main/pull-requests/bitbucket-map'
import { BITBUCKET_API, BitbucketClient, BitbucketProvider, testBitbucket } from '../../src/main/pull-requests/bitbucket'
import type { RepoRef } from '../../src/shared/pull-requests'

const dir = join(__dirname, '../fixtures/pull-requests')
const fixture = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'))
const repo: RepoRef = { host: 'bitbucket', owner: 'geoiq', name: 'ssg-bot-v2' }
const viewer: BbViewer = { uuid: '{me-uuid}', accountId: '557058:me' }
const open = fixture('bitbucket-pullrequests-open.json').values
const comments = fixture('bitbucket-comments.json').values
const statuses = fixture('bitbucket-statuses.json').values

describe('mapBbStatuses', () => {
  it('maps states and takes the time between first and last post as the duration', () => {
    expect(mapBbStatuses(statuses).map((c) => [c.name, c.state, c.durationMs])).toEqual([
      ['lint', 'success', 62_000],
      ['integration', 'failure', 240_000],
      ['build-image', 'pending', null],
      ['deploy', 'neutral', null],
    ])
    expect(mapBbStatuses(statuses)[1].description).toBe('test_sync_resume timed out after 120 s')
  })
})

describe('mapBbComments', () => {
  const threads = mapBbComments(comments)

  it('builds inline threads, joining nested replies to their root', () => {
    expect(threads.map((t) => [t.id, t.path, t.line, t.side, t.resolved, t.outdated, t.comments.length])).toEqual([
      ['1', 'sync/worker.py', 86, 'new', false, false, 3],
      ['4', 'sync/worker.py', 84, 'old', true, false, 1],
      ['5', 'tests/test_worker.py', null, 'new', false, true, 1],
    ])
    expect(threads[0].comments.map((c) => c.author.login)).toEqual(['pankaj', 'tejas', 'pankaj'])
    expect(threads[0].comments[0].url).toContain('#comment-1')
  })

  it('leaves out comments on the whole PR and threads with only deleted comments', () => {
    expect(threads.some((t) => t.path === null)).toBe(false)
    expect(threads.some((t) => t.path === 'sync/config.py')).toBe(false)
  })
})

describe('mapBbSummary', () => {
  const extra = { checks: mapBbStatuses(statuses), unresolvedConversations: 2 }

  it('reads reviewers, approvals and your part in it', () => {
    const pr = mapBbSummary(repo, open[0], viewer, extra)
    expect(pr.ref).toEqual({ ...repo, number: 612 })
    expect(pr.viewer).toEqual({ isAuthor: true, isRequestedReviewer: false, hasReviewed: false })
    expect(pr.reviewers.map((r) => [r.person.login, r.state, r.requested])).toEqual([
      ['akshaya', 'approved', true],
      ['pankaj', 'changes_requested', true],
      ['backend', 'commented', false],
    ])
    expect(pr.approvals).toEqual({ given: 1, required: null })
    expect(pr.checks).toEqual({ state: 'failure', total: 4, passed: 2, failed: 1, pending: 1 })
    expect(pr.unresolvedConversations).toBe(2)
    expect(pr.url).toBe('https://bitbucket.org/geoiq/ssg-bot-v2/pull-requests/612')
    expect(pr.additions).toBeNull()
  })

  it('marks a requested reviewer who has not participated', () => {
    const pr = mapBbSummary(repo, open[1], viewer, null)
    expect(pr.viewer).toEqual({ isAuthor: false, isRequestedReviewer: true, hasReviewed: false })
    expect(pr.reviewers).toEqual([{ person: expect.objectContaining({ displayName: 'Tejas Nafde' }), state: 'pending', requested: true }])
    expect(pr.unresolvedConversations).toBeNull()
    expect(pr.checks.state).toBe('none')
  })

  it('uses the last update as the merge time of a merged PR', () => {
    const pr = mapBbSummary(repo, fixture('bitbucket-pullrequests-merged.json').values[0], viewer, null)
    expect(pr.state).toBe('merged')
    expect(pr.mergedAt).toBe(Date.parse('2026-09-25T12:00:00+00:00'))
  })
})

describe('mapBbFiles', () => {
  const files = mapBbFiles(fixture('bitbucket-diffstat.json').values, readFileSync(join(dir, 'bitbucket-diff.txt'), 'utf8'))

  it('pairs the diffstat with each file\'s hunks', () => {
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions, f.hunks.length, f.binary])).toEqual([
      ['sync/worker.py', 'modified', 2, 1, 1, false],
      ['sync/backoff.py', 'added', 3, 0, 1, false],
      ['sync/legacy.py', 'deleted', 0, 2, 1, false],
      ['docs/new name.md', 'renamed', 0, 0, 0, false],
      ['assets/logo.png', 'added', 0, 0, 0, true],
    ])
    expect(files[3].oldPath).toBe('docs/old name.md')
    expect(files[0].hunks[0].lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['context', 84, 84], ['del', 85, null], ['add', null, 85], ['add', null, 86], ['context', 86, 87],
    ])
    expect(files[2].hunks[0].lines.every((l) => l.kind === 'del')).toBe(true)
  })

  it('reads a CRLF diff exactly like an LF one, with no CR left in paths or text', () => {
    // Pinned to LF by .gitattributes; a server or a proxy can still send CRLF.
    const lf = readFileSync(join(dir, 'bitbucket-diff.txt'), 'utf8').replace(/\r\n/g, '\n')
    const crlf = mapBbFiles(fixture('bitbucket-diffstat.json').values, lf.replace(/\n/g, '\r\n'))
    expect(crlf).toEqual(mapBbFiles(fixture('bitbucket-diffstat.json').values, lf))
    expect(JSON.stringify(crlf)).not.toContain('\\r')
  })
})

describe('mapBbActivity and mapBbDetail', () => {
  it('orders activity oldest first and collapses repeated updates to one head', () => {
    const rows = mapBbActivity(fixture('bitbucket-activity.json').values)
    expect(rows.map((r) => `${r.actor?.displayName} ${r.summary}${r.detail ? ` | ${r.detail}` : ''}`)).toEqual([
      'akshaya approved',
      'pankaj requested changes',
      'Tejas Nafde updated the pull request | head a1b2c3d',
      'Tejas Nafde commented | sync/worker.py: "Done in a1b2c3d."',
    ])
  })

  it('fills sizes from the diffstat and lists the blockers', () => {
    const detail = mapBbDetail(
      repo,
      open[0],
      viewer,
      { checks: mapBbStatuses(statuses), unresolvedConversations: 2 },
      fixture('bitbucket-diffstat.json').values,
      fixture('bitbucket-activity.json').values,
    )
    expect([detail.additions, detail.deletions, detail.changedFiles]).toEqual([5, 3, 5])
    expect(detail.headSha).toBe('a1b2c3d4e5f6')
    expect(detail.description).toBe('Replaces the fixed 30 s retry.')
    expect(detail.mergeBlockers.map((b) => b.kind)).toEqual(['checks_failed', 'unresolved_conversations', 'changes_requested'])
  })
})

// ─── Client + provider over a fake fetch ─────────────────────────

type Route = { status?: number; body: unknown; headers?: Record<string, string> }

function fakeFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const impl = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers })
    const path = url.slice(BITBUCKET_API.length).split('?')[0]
    // `path#STATE` serves one pull request state, so the open and merged lists can differ.
    const state = new URL(url).searchParams.get('state')
    const route = (state && routes[`${path}#${state}`]) || routes[path]
    const status = route?.status ?? (route ? 200 : 404)
    const body = route?.body ?? {}
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => route?.headers?.[name.toLowerCase()] ?? null },
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    }
  }
  return { impl, calls }
}

const creds = { email: 'me@example.com', apiToken: 'ATATT-secret-token' }
const base = '/repositories/geoiq/ssg-bot-v2'

function providerRoutes(): Record<string, Route> {
  return {
    '/user': { body: fixture('bitbucket-user.json') },
    [`${base}/pullrequests#OPEN`]: { body: fixture('bitbucket-pullrequests-open.json') },
    [`${base}/pullrequests#MERGED`]: { body: fixture('bitbucket-pullrequests-merged.json') },
    [`${base}/pullrequests/612/comments`]: { body: fixture('bitbucket-comments.json') },
    [`${base}/pullrequests/88/comments`]: { body: { values: [] } },
    [`${base}/commit/a1b2c3d4e5f6/statuses`]: { body: fixture('bitbucket-statuses.json') },
    [`${base}/commit/ffee00/statuses`]: { body: { values: [] } },
  }
}

describe('BitbucketClient', () => {
  it('sends Basic auth to api.bitbucket.org only', async () => {
    const { impl, calls } = fakeFetch({ '/user': { body: { uuid: 'x' } } })
    await new BitbucketClient(creds, impl).json('/user')
    expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from('me@example.com:ATATT-secret-token').toString('base64')}`)
  })

  it('refuses a next page on another origin instead of sending the token there', async () => {
    const { impl, calls } = fakeFetch({ '/things': { body: { values: [1], next: 'https://evil.example/2.0/things?page=2' } } })
    await expect(new BitbucketClient(creds, impl).paged('/things')).rejects.toMatchObject({ error: { kind: 'unknown' } })
    expect(calls).toHaveLength(1)
  })

  it.each([
    [401, 'token_rejected'],
    [403, 'token_rejected'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'unknown'],
  ])('classifies HTTP %i as %s', async (status, kind) => {
    const { impl } = fakeFetch({ '/user': { status, body: {}, headers: { 'retry-after': '30' } } })
    await expect(new BitbucketClient(creds, impl).json('/user')).rejects.toMatchObject({ error: { kind } })
  })

  it('classifies a failed fetch as offline, with no token in the message', async () => {
    const impl = async () => { throw new TypeError('fetch failed') }
    const err = await new BitbucketClient(creds, impl).json('/user').catch((e) => e)
    expect(err.error.kind).toBe('offline')
    expect(JSON.stringify(err.error)).not.toContain('ATATT')
  })
})

describe('BitbucketProvider', () => {
  it('lists only PRs that involve you, with checks and open conversations', async () => {
    const { impl } = fakeFetch(providerRoutes())
    const provider = new BitbucketProvider(new BitbucketClient(creds, impl), () => Date.parse('2026-09-27T12:00:00Z'))
    const [result] = await provider.list([repo])
    expect(result.error).toBeNull()
    // #70 is someone else's and nobody asked you to review it.
    expect(result.prs.map((p) => p.ref.number)).toEqual([612, 88, 600])
    expect(result.prs[2].state).toBe('merged')
    const bot = result.prs[0]
    expect(bot.unresolvedConversations).toBe(2)
    expect(bot.checks.failed).toBe(1)
  })

  it('re-reads enrichment only when the PR changed or its checks were running', async () => {
    let now = Date.parse('2026-09-27T12:00:00Z')
    const routes = providerRoutes()
    routes[`${base}/commit/a1b2c3d4e5f6/statuses`] = { body: { values: [statuses[0]] } }
    const { impl, calls } = fakeFetch(routes)
    const provider = new BitbucketProvider(new BitbucketClient(creds, impl), () => now)
    await provider.list([repo])
    const enrichCalls = () => calls.filter((c) => c.url.includes('/comments') || c.url.includes('/statuses')).length
    const first = enrichCalls()
    now += 60_000
    await provider.list([repo])
    expect(enrichCalls()).toBe(first)
  })

  it('names the whole list failing when the token is rejected', async () => {
    const { impl } = fakeFetch({ '/user': { status: 401, body: {} } })
    const provider = new BitbucketProvider(new BitbucketClient(creds, impl))
    await expect(provider.list([repo])).rejects.toMatchObject({ error: { kind: 'token_rejected' } })
  })

  it('reports one repository it cannot see without failing the rest', async () => {
    const { impl } = fakeFetch(providerRoutes())
    const provider = new BitbucketProvider(new BitbucketClient(creds, impl))
    const results = await provider.list([repo, { host: 'bitbucket', owner: 'geoiq', name: 'private-one' }])
    expect(results[1]).toMatchObject({ prs: [], error: { kind: 'not_found' } })
    expect(results[0].error).toBeNull()
  })
})

describe('testBitbucket', () => {
  const repos = [
    { host: 'bitbucket' as const, owner: 'geoiq', name: 'ssg-bot-v2' },
    { host: 'bitbucket' as const, owner: 'geoiq', name: 'retailiq' },
    { host: 'bitbucket' as const, owner: 'personal', name: 'notes' },
  ]
  const WRITES = ' Replies, approvals and merges (write:pullrequest:bitbucket) are only checked on the first one.'
  const readable = (owner: string, name: string): Record<string, Route> => ({
    [`/repositories/${owner}/${name}`]: { body: {} },
    [`/repositories/${owner}/${name}/pullrequests`]: { body: { size: 0 } },
  })

  it('reads each repository and its pull requests, and names the ones it cannot read', async () => {
    const { impl, calls } = fakeFetch({
      '/user': { body: { display_name: 'Tejas Nafde' } },
      ...readable('geoiq', 'ssg-bot-v2'),
      ...readable('geoiq', 'retailiq'),
    })
    const result = await testBitbucket(new BitbucketClient(creds, impl), repos)
    expect(result).toEqual({ ok: true, message: `Signed in as Tejas Nafde. Can read 2 of your 3 project repositories and their pull requests; cannot read personal/notes.${WRITES}` })
    expect(calls.map((c) => c.url.split('?')[0].slice(BITBUCKET_API.length)).sort()).toEqual([
      '/repositories/geoiq/retailiq', '/repositories/geoiq/retailiq/pullrequests',
      '/repositories/geoiq/ssg-bot-v2', '/repositories/geoiq/ssg-bot-v2/pullrequests',
      '/repositories/personal/notes', '/user',
    ])
    expect(calls.every((c) => !c.url.includes('/user/permissions'))).toBe(true)
  })

  it('says what it checked when every repository works, or there are none', async () => {
    const { impl } = fakeFetch({ '/user': { body: { display_name: 'Tejas' } }, ...readable('geoiq', 'ssg-bot-v2') })
    expect(await testBitbucket(new BitbucketClient(creds, impl), repos.slice(0, 1))).toEqual({
      ok: true, message: `Signed in as Tejas. Can read your project repository and its pull requests.${WRITES}`,
    })
    expect(await testBitbucket(new BitbucketClient(creds, impl), [])).toEqual({
      ok: true, message: 'Signed in as Tejas. None of your projects points at a Bitbucket repository yet, so no repository was checked.',
    })
  })

  it('does not report success when the repository reads but its pull requests do not', async () => {
    const { impl } = fakeFetch({
      '/user': { body: {} },
      '/repositories/geoiq/ssg-bot-v2': { body: {} },
      '/repositories/geoiq/ssg-bot-v2/pullrequests': { status: 403, body: {} },
    })
    expect(await testBitbucket(new BitbucketClient(creds, impl), repos.slice(0, 1))).toEqual({
      ok: false,
      message: 'Signed in. Can read 0 of your 1 project repository and their pull requests; cannot read geoiq/ssg-bot-v2. The API token may be missing the read:pullrequest:bitbucket scope.',
    })
  })

  it('names the repository scope when the token cannot read any', async () => {
    const { impl } = fakeFetch({
      '/user': { body: {} },
      '/repositories/geoiq/ssg-bot-v2': { status: 403, body: {} },
      '/repositories/geoiq/retailiq': { status: 403, body: {} },
      '/repositories/personal/notes': { status: 403, body: {} },
    })
    const result = await testBitbucket(new BitbucketClient(creds, impl), repos)
    expect(result.ok).toBe(false)
    expect(result.message).toBe('Signed in. Can read 0 of your 3 project repositories and their pull requests; cannot read geoiq/retailiq, geoiq/ssg-bot-v2, personal/notes. The API token may be missing the read:repository:bitbucket scope.')
  })

  it('caps the repositories it checks', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ host: 'bitbucket' as const, owner: 'ws', name: `r${i}` }))
    const routes: Record<string, Route> = { '/user': { body: {} } }
    for (const r of many) Object.assign(routes, readable('ws', r.name))
    const { impl, calls } = fakeFetch(routes)
    const result = await testBitbucket(new BitbucketClient(creds, impl), many)
    expect(calls).toHaveLength(41)
    expect(result.message).toBe(`Signed in. Can read all 20 of your project repositories and their pull requests. Checked the first 20 of 25.${WRITES}`)
  })

  it('says why a rejected token failed', async () => {
    const { impl } = fakeFetch({ '/user': { status: 401, body: {} } })
    expect(await testBitbucket(new BitbucketClient(creds, impl), repos)).toEqual({ ok: false, message: 'Bitbucket rejected the email and API token.' })
  })

  it('names the user scope when /user is forbidden', async () => {
    const { impl } = fakeFetch({ '/user': { status: 403, body: {} } })
    expect(await testBitbucket(new BitbucketClient(creds, impl), repos)).toEqual({ ok: false, message: 'The API token is missing the read:user:bitbucket scope.' })
  })
})
