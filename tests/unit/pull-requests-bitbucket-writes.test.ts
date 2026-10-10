/**
 * Bitbucket writes against a fake fetch: each request's method, URL and JSON
 * body, the review that is comments first and then approve or request
 * changes (and how it reports a failure part way), the merge strategy names,
 * and the typed errors. No test reaches bitbucket.org.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

import {
  BITBUCKET_API,
  BitbucketClient,
  BitbucketProvider,
  bitbucketWriteError,
  type FetchLike,
} from '../../src/main/pull-requests/bitbucket'
import { mapBbMergeStrategies } from '../../src/main/pull-requests/bitbucket-map'
import type { PrRef } from '../../src/shared/pull-requests'

const ref: PrRef = { host: 'bitbucket', owner: 'geoiq', name: 'ssg-bot-v2', number: 612 }
const PR = `${BITBUCKET_API}/repositories/geoiq/ssg-bot-v2/pullrequests/612`

interface Answer {
  status: number
  body?: unknown
  headers?: Record<string, string>
}
interface Sent {
  method: string
  url: string
  body: unknown
  contentType: string | undefined
}

function fakeFetch(answers: Answer[] = []) {
  const sent: Sent[] = []
  const impl: FetchLike = vi.fn(async (url, init) => {
    sent.push({
      method: init.method ?? 'GET',
      url,
      body: init.body ? JSON.parse(init.body) : undefined,
      contentType: init.headers['Content-Type'],
    })
    const a = answers.shift() ?? { status: 200, body: {} }
    const text = a.body === undefined ? '' : JSON.stringify(a.body)
    return {
      ok: a.status >= 200 && a.status < 300,
      status: a.status,
      headers: { get: (name: string) => a.headers?.[name.toLowerCase()] ?? null },
      json: async () => a.body,
      text: async () => text,
    }
  })
  const provider = new BitbucketProvider(new BitbucketClient({ email: 'me@example.com', apiToken: 'tok-secret' }, impl))
  return { provider, sent }
}

describe('Bitbucket write requests', () => {
  it('replies under the conversation root', async () => {
    const { provider, sent } = fakeFetch()
    await provider.reply(ref, '812', 'Done in a1b2c3d.')
    expect(sent).toEqual([
      {
        method: 'POST',
        url: `${PR}/comments`,
        body: { content: { raw: 'Done in a1b2c3d.' }, parent: { id: 812 } },
        contentType: 'application/json',
      },
    ])
  })

  it('resolves with POST and unresolves with DELETE on the root comment', async () => {
    const { provider, sent } = fakeFetch([{ status: 200, body: {} }, { status: 204 }])
    await provider.setResolved(ref, '812', true)
    await provider.setResolved(ref, '812', false)
    expect(sent.map((s) => [s.method, s.url, s.body])).toEqual([
      ['POST', `${PR}/comments/812/resolve`, undefined],
      ['DELETE', `${PR}/comments/812/resolve`, undefined],
    ])
  })

  it('anchors a line comment with to on the new side and from on the old side', async () => {
    const { provider, sent } = fakeFetch()
    await provider.inlineComment(ref, { path: 'sync/worker.py', side: 'new', line: 86, body: 'Cap it.' })
    await provider.inlineComment(ref, { path: 'sync/worker.py', side: 'old', line: 84, startLine: 82, body: 'Why?' })
    await provider.comment(ref, 'On the whole PR')
    expect(sent.map((s) => s.body)).toEqual([
      { content: { raw: 'Cap it.' }, inline: { path: 'sync/worker.py', to: 86 } },
      { content: { raw: 'Why?' }, inline: { path: 'sync/worker.py', from: 84, start_from: 82 } },
      { content: { raw: 'On the whole PR' } },
    ])
  })

  it('submits a review as the comments, the summary, then the verdict', async () => {
    const { provider, sent } = fakeFetch()
    await provider.submitReview(ref, {
      event: 'request_changes',
      body: 'Two things.',
      comments: [
        { path: 'a.py', side: 'new', line: 1, body: 'one' },
        { path: 'b.py', side: 'new', line: 9, startLine: 2, body: 'two' },
      ],
    })
    expect(sent[1].body).toEqual({ content: { raw: 'two' }, inline: { path: 'b.py', to: 9, start_to: 2 } })
    expect(sent.map((s) => [s.method, s.url.replace(PR, '')])).toEqual([
      ['POST', '/comments'],
      ['POST', '/comments'],
      ['POST', '/comments'],
      ['POST', '/request-changes'],
    ])
    expect(sent[2].body).toEqual({ content: { raw: 'Two things.' } })
  })

  it('approves without a summary comment when there is none', async () => {
    const { provider, sent } = fakeFetch()
    await provider.submitReview(ref, { event: 'approve', body: '', comments: [] })
    expect(sent.map((s) => [s.method, s.url])).toEqual([['POST', `${PR}/approve`]])
  })

  it('says how many comments went when a review fails part way', async () => {
    const { provider, sent } = fakeFetch([
      { status: 201, body: {} },
      { status: 429, headers: { 'retry-after': '30' } },
    ])
    await expect(
      provider.submitReview(ref, {
        event: 'comment',
        body: '',
        comments: [
          { path: 'a.py', side: 'new', line: 1, body: 'one' },
          { path: 'b.py', side: 'new', line: 2, body: 'two' },
        ],
      }),
    ).rejects.toMatchObject({ error: { kind: 'rate_limited', postedComments: 1 } })
    expect(sent).toHaveLength(2)
  })

  it('merges with the Bitbucket strategy name', async () => {
    const { provider, sent } = fakeFetch([{ status: 200, body: {} }, { status: 202 }])
    await provider.merge(ref, 'merge_commit')
    await provider.merge(ref, 'rebase')
    expect(sent.map((s) => [s.method, s.url, s.body])).toEqual([
      ['POST', `${PR}/merge`, { type: 'pullrequest', merge_strategy: 'merge_commit' }],
      ['POST', `${PR}/merge`, { type: 'pullrequest', merge_strategy: 'rebase_fast_forward' }],
    ])
  })

  it('never sends a re-run: the API has none', async () => {
    const { provider, sent } = fakeFetch()
    await expect(provider.rerunCheck()).rejects.toMatchObject({ error: { kind: 'forbidden' } })
    expect(sent).toHaveLength(0)
  })
})

describe('bitbucketWriteError', () => {
  const res = (status: number, body?: unknown, headers: Record<string, string> = {}) => ({
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  })

  it.each([
    [
      400,
      { error: { message: 'Bad request', detail: 'inline.to must be on the diff' } },
      'invalid',
      'Bad request: inline.to must be on the diff',
    ],
    [401, undefined, 'token_rejected', 'Bitbucket rejected the email and API token.'],
    [
      403,
      { error: { message: 'You cannot approve your own pull request' } },
      'forbidden',
      'You cannot approve your own pull request',
    ],
    [404, undefined, 'stale', 'Bitbucket could not find it; it may have been deleted.'],
    [
      409,
      { error: { message: 'Pull request has unresolved merge conflicts' } },
      'conflict',
      'Pull request has unresolved merge conflicts',
    ],
    [500, 'not json', 'unknown', 'Bitbucket answered 500.'],
  ])('%d -> %s', async (status, body, kind, message) => {
    expect(await bitbucketWriteError(res(status, body))).toEqual({ kind, host: 'bitbucket', message })
  })

  it('carries the retry time of a rate limit', async () => {
    const error = await bitbucketWriteError(res(429, undefined, { 'retry-after': '60' }))
    expect(error.kind).toBe('rate_limited')
    expect(error.retryAt).toBeGreaterThan(Date.now())
  })

  it('never puts the token in an error', async () => {
    const { provider } = fakeFetch([{ status: 403, body: { error: { message: 'Forbidden' } } }])
    const err = await provider.comment(ref, 'x').catch((e: unknown) => e)
    expect(JSON.stringify(err)).not.toContain('tok-secret')
  })
})

describe('Bitbucket reviewer and decline requests', () => {
  const A = '{00000000-0000-4000-8000-00000000000a}'
  const B = '{00000000-0000-4000-8000-00000000000b}'
  const current = {
    status: 200,
    body: { id: 612, title: 'Jittered backoff', description: 'keep <!-- me -->', reviewers: [{ uuid: A }] },
  }

  it('adds a reviewer by PUT with the title and the whole list, never the description', async () => {
    const { provider, sent } = fakeFetch([current, { status: 200, body: {} }])
    await provider.addReviewer(ref, B)
    expect(sent.map((s) => [s.method, s.url])).toEqual([
      ['GET', PR],
      ['PUT', PR],
    ])
    expect(sent[1].body).toEqual({ title: 'Jittered backoff', reviewers: [{ uuid: A }, { uuid: B }] })
  })

  it('removes one by PUT with the others, and does not add one twice', async () => {
    const { provider, sent } = fakeFetch([current, { status: 200, body: {} }, current, { status: 200, body: {} }])
    await provider.removeReviewer(ref, A)
    await provider.addReviewer(ref, A)
    expect(sent[1].body).toEqual({ title: 'Jittered backoff', reviewers: [] })
    expect(sent[3].body).toEqual({ title: 'Jittered backoff', reviewers: [{ uuid: A }] })
  })

  it('declines with POST decline', async () => {
    const { provider, sent } = fakeFetch()
    await provider.decline(ref)
    expect(sent.map((s) => [s.method, s.url, s.body])).toEqual([['POST', `${PR}/decline`, undefined]])
  })

  it("maps a refused reviewer change to the typed error with Bitbucket's reason", async () => {
    const { provider } = fakeFetch([
      current,
      {
        status: 400,
        body: { error: { message: 'Bad request', detail: 'reviewers: pankaj is the author of the pull request' } },
      },
    ])
    await expect(provider.addReviewer(ref, B)).rejects.toMatchObject({
      error: { kind: 'invalid', message: 'Bad request: reviewers: pankaj is the author of the pull request' },
    })
  })

  it('offers workspace members by uuid, and none without the workspace scope', async () => {
    const members = {
      status: 200,
      body: {
        values: [
          { user: { display_name: 'barath', nickname: 'barath', uuid: B } },
          { user: { display_name: 'no id' } },
        ],
      },
    }
    const { provider, sent } = fakeFetch([members])
    const repo = { host: 'bitbucket' as const, owner: 'geoiq', name: 'ssg-bot-v2' }
    expect(await provider.reviewerCandidates(repo)).toEqual([
      { id: B, person: { login: 'barath', displayName: 'barath', avatarUrl: null }, kind: 'user', reviewed: 0 },
    ])
    expect(sent[0].url).toBe(`${BITBUCKET_API}/workspaces/geoiq/members?pagelen=100`)
    const denied = fakeFetch([{ status: 403, body: {} }])
    expect(await denied.provider.reviewerCandidates(repo)).toEqual([])
  })

  it("reads a workspace's members once per 10 minutes across its repositories, and not an offline failure", async () => {
    let now = 0
    let calls = 0
    let offline = true
    const impl: FetchLike = vi.fn(async () => {
      calls++
      if (offline) throw new TypeError('fetch failed')
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ values: [{ user: { display_name: 'barath', uuid: B } }] }),
        text: async () => '',
      }
    })
    const provider = new BitbucketProvider(
      new BitbucketClient({ email: 'me@example.com', apiToken: 'tok-secret' }, impl),
      () => now,
    )
    const repo = (name: string) => ({ host: 'bitbucket' as const, owner: 'geoiq', name })
    await expect(provider.reviewerCandidates(repo('a'))).rejects.toMatchObject({ error: { kind: 'offline' } })
    offline = false
    const [a, b] = await Promise.all([provider.reviewerCandidates(repo('a')), provider.reviewerCandidates(repo('b'))])
    expect(a).toEqual(b)
    expect(calls).toBe(2)
    now = 9 * 60_000
    await provider.reviewerCandidates(repo('c'))
    expect(calls).toBe(2)
    now = 11 * 60_000
    await provider.reviewerCandidates(repo('a'))
    expect(calls).toBe(3)
  })

  it('keeps a refused member read but asks again after a rate limit or a server error', async () => {
    const repo = { host: 'bitbucket' as const, owner: 'geoiq', name: 'a' }
    const refused = fakeFetch([{ status: 403, body: {} }])
    expect(await refused.provider.reviewerCandidates(repo)).toEqual([])
    expect(await refused.provider.reviewerCandidates(repo)).toEqual([])
    expect(refused.sent).toHaveLength(1)
    const members = { status: 200, body: { values: [{ user: { display_name: 'barath', uuid: B } }] } }
    const flaky = fakeFetch([{ status: 429, body: {} }, { status: 503, body: {} }, members])
    expect(await flaky.provider.reviewerCandidates(repo)).toEqual([])
    expect(await flaky.provider.reviewerCandidates(repo)).toEqual([])
    expect((await flaky.provider.reviewerCandidates(repo)).map((c) => c.id)).toEqual([B])
    expect(flaky.sent).toHaveLength(3)
  })
})

describe('mapBbMergeStrategies', () => {
  it('maps the destination branch strategies, merge commit first', () => {
    expect(
      mapBbMergeStrategies({
        destination: {
          branch: {
            name: 'main',
            merge_strategies: ['squash', 'rebase_fast_forward', 'merge_commit', 'something_new'],
          },
        },
      }),
    ).toEqual(['merge_commit', 'squash', 'rebase'])
  })

  it('falls back to Bitbucket defaults when the branch does not list them', () => {
    expect(mapBbMergeStrategies({ destination: { branch: { name: 'main' } } })).toEqual([
      'merge_commit',
      'fast_forward',
      'squash',
    ])
  })
})
