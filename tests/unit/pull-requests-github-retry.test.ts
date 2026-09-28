/**
 * GitHub answers a read with a transient 5xx now and then (a 502 on the list
 * query, five times in one user's ten hours). A read is tried once more after
 * a pause; a write never is, and neither is a 404 or a signed-out gh. Fake gh
 * only, no network.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/logger', () => ({ createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))
vi.mock('../../src/main/shell-env', () => ({ childProcessEnv: () => ({}) }))

import { GH_TIMED_OUT, isTransientGhFailure } from '../../src/main/pull-requests/github-map'
import { GitHubProvider, type GhRunner, type GhRunResult } from '../../src/main/pull-requests/github'
import type { RepoRef } from '../../src/shared/pull-requests'

const repo: RepoRef = { host: 'github', owner: 'tejasnafde', name: 'switchboard' }
const ok = (stdout: string): GhRunResult => ({ stdout, stderr: '', code: 0 })
const fail = (stderr: string, stdout = ''): GhRunResult => ({ stdout, stderr, code: 1 })
const LIST = JSON.stringify({ data: { viewer: { login: 'tejasnafde' }, r0: { open: { nodes: [] }, merged: { nodes: [] } } } })

describe('isTransientGhFailure', () => {
  it.each([
    ['gh: HTTP 502', true],
    ['gh: Bad Gateway (HTTP 502)', true],
    ['HTTP 500: Internal Server Error', true],
    ['gh: Service Unavailable (HTTP 503)', true],
    ['HTTP 504: Gateway Timeout', true],
    ['GraphQL: Something went wrong while executing your query. Please include `ABCD:1234` when reporting this issue.', true],
    ['HTTP 501', false],
    ['HTTP 5021', false],
    ['unexpected end of JSON input', true],
    ['gh: unexpected EOF', true],
    ['gh: Not Found (HTTP 404)', false],
    ['To get started with GitHub CLI, please run:  gh auth login', false],
    ['API rate limit exceeded (HTTP 403)', false],
  ])('%s -> %s', (stderr, transient) => {
    expect(isTransientGhFailure(fail(stderr))).toBe(transient)
  })

  it('counts a gh killed for taking too long', () => {
    expect(isTransientGhFailure({ stdout: '', stderr: '', code: GH_TIMED_OUT })).toBe(true)
  })

  it('ignores success, a missing gh, and stdout (PR text can say anything)', () => {
    expect(isTransientGhFailure({ stdout: '', stderr: 'HTTP 502', code: 0 })).toBe(false)
    expect(isTransientGhFailure({ stdout: '', stderr: 'HTTP 502', code: 'ENOENT' })).toBe(false)
    expect(isTransientGhFailure(fail('', 'body mentions HTTP 502'))).toBe(false)
  })
})

describe('GitHubProvider read retry', () => {
  it('retries the list once after a 502 and returns the second answer', async () => {
    const run = vi.fn<GhRunner>().mockResolvedValueOnce(fail('gh: HTTP 502')).mockResolvedValueOnce(ok(LIST))
    const results = await new GitHubProvider(run, 0).list([repo])
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1][0]).toEqual(run.mock.calls[0][0])
    expect(results[0]).toMatchObject({ error: null, prs: [] })
  })

  it('waits before the retry', async () => {
    vi.useFakeTimers()
    try {
      const run = vi.fn<GhRunner>().mockResolvedValueOnce(fail('gh: HTTP 503')).mockResolvedValueOnce(ok('tejasnafde\n'))
      const login = new GitHubProvider(run, 1_000).viewerLogin()
      await vi.advanceTimersByTimeAsync(999)
      expect(run).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(await login).toBe('tejasnafde')
      expect(run).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries only once, then gives the repository its own error', async () => {
    const run = vi.fn<GhRunner>().mockResolvedValue(fail('gh: HTTP 502'))
    const [result] = await new GitHubProvider(run, 0).list([repo])
    expect(result).toMatchObject({ repo, prs: [], error: { kind: 'unknown', message: 'gh: HTTP 502' } })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('retries the files and detail reads too', async () => {
    const run = vi.fn<GhRunner>().mockResolvedValueOnce(fail('HTTP 504')).mockResolvedValueOnce(ok('[]'))
    expect(await new GitHubProvider(run, 0).files({ ...repo, number: 5 })).toEqual([])
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not retry a 404 or a signed-out gh', async () => {
    const notFound = vi.fn<GhRunner>().mockResolvedValue(fail('gh: Not Found (HTTP 404)'))
    await expect(new GitHubProvider(notFound, 0).files({ ...repo, number: 5 })).rejects.toMatchObject({ error: { kind: 'not_found' } })
    expect(notFound).toHaveBeenCalledTimes(1)
    const signedOut = vi.fn<GhRunner>().mockResolvedValue(fail('gh auth login'))
    await expect(new GitHubProvider(signedOut, 0).viewerLogin()).rejects.toMatchObject({ error: { kind: 'token_rejected' } })
    expect(signedOut).toHaveBeenCalledTimes(1)
  })

  it('never re-sends a write', async () => {
    const rest = vi.fn<GhRunner>().mockResolvedValue(fail('gh: HTTP 502'))
    await expect(new GitHubProvider(rest, 0).comment({ ...repo, number: 5 }, 'hi')).rejects.toBeDefined()
    expect(rest).toHaveBeenCalledTimes(1)
    const mutation = vi.fn<GhRunner>().mockResolvedValue(fail('GraphQL: Something went wrong while executing your query.'))
    await expect(new GitHubProvider(mutation, 0).reply({ ...repo, number: 5 }, 'PRRT_1', 'hi')).rejects.toBeDefined()
    expect(mutation).toHaveBeenCalledTimes(1)
  })

  it('reports a repository GitHub refuses (SAML, IP allow list) as forbidden, not missing', async () => {
    const body = { data: { viewer: { login: 'me' }, r0: null }, errors: [{ type: 'FORBIDDEN', path: ['r0'], message: 'Resource protected by organization SAML enforcement.' }] }
    const run = vi.fn<GhRunner>().mockResolvedValue({ stdout: JSON.stringify(body), stderr: 'GraphQL: Resource protected', code: 1 })
    const [result] = await new GitHubProvider(run, 0).list([repo])
    expect(result.error).toMatchObject({ kind: 'forbidden', message: 'Resource protected by organization SAML enforcement.' })
  })
})

describe('GitHubProvider list batches', () => {
  const repos = (...names: string[]): RepoRef[] => names.map((name) => ({ host: 'github', owner: 'geoiq', name }))
  /** Names of the repositories a list query asks for, in order. */
  const asked = (args: string[]) => [...(args.find((a) => a.startsWith('query=')) ?? '').matchAll(/name: "([^"]+)"/g)].map((m) => m[1])
  const answer = (names: string[]) => ok(JSON.stringify({
    data: {
      viewer: { login: 'me' },
      ...Object.fromEntries(names.map((name, i) => [`r${i}`, { open: { nodes: [{
        number: i + 1, title: name, url: '', state: 'OPEN', isDraft: false, createdAt: '2026-09-27T00:00:00Z', updatedAt: '2026-09-27T00:00:00Z',
        mergedAt: null, headRefName: 'f', baseRefName: 'main', author: { login: 'me' },
      }] }, merged: { nodes: [] } }])),
    },
  }))
  /** A fake gh that fails every query naming more than `max` repositories, and every query for the repositories in `broken`. */
  const gh = (failure: GhRunResult, max: number, broken: string[] = []) => vi.fn<GhRunner>(async (args) => {
    const names = asked(args)
    return names.length > max || names.some((n) => broken.includes(n)) ? failure : answer(names)
  })
  const listed = (results: Awaited<ReturnType<GitHubProvider['list']>>) => results.map((r) => [r.repo.name, r.error?.kind ?? null, r.prs.map((p) => p.title)])

  it('splits a batch GitHub timed out on (HTTP 504) and lists every repository', async () => {
    const run = gh(fail("gh: We couldn't respond to your request in time. Sorry about that. (HTTP 504)"), 1)
    const results = await new GitHubProvider(run, 0).list(repos('a', 'b', 'c'))
    expect(listed(results)).toEqual([['a', null, ['a']], ['b', null, ['b']], ['c', null, ['c']]])
    // The whole batch is not retried: 3 at once, then 2 (a, b), then each of a and b, then c.
    expect(run.mock.calls.map((c) => asked(c[0]))).toEqual([['a', 'b', 'c'], ['a', 'b'], ['a'], ['b'], ['c']])
  })

  it('splits a batch whose body arrived cut short', async () => {
    const truncated = vi.fn<GhRunner>(async (args) => (asked(args).length > 1 ? fail('unexpected end of JSON input') : answer(asked(args))))
    expect(listed(await new GitHubProvider(truncated, 0).list(repos('a', 'b')))).toEqual([['a', null, ['a']], ['b', null, ['b']]])
    // gh exited 0 with half a body.
    const cut = vi.fn<GhRunner>(async (args) => (asked(args).length > 1 ? ok('{"data": {"viewer": {"lo') : answer(asked(args))))
    expect(listed(await new GitHubProvider(cut, 0).list(repos('a', 'b')))).toEqual([['a', null, ['a']], ['b', null, ['b']]])
  })

  it('gives one repository that keeps failing its own error and lists the rest', async () => {
    const run = gh(fail('gh: HTTP 504'), 4, ['b'])
    const results = await new GitHubProvider(run, 0).list(repos('a', 'b', 'c'))
    expect(listed(results)).toEqual([['a', null, ['a']], ['b', 'unknown', []], ['c', null, ['c']]])
    expect(results[1].error?.message).toBe('gh: HTTP 504')
    // b alone is tried twice (the one retry); nothing else is.
    expect(run.mock.calls.filter((c) => asked(c[0]).join() === 'b')).toHaveLength(2)
  })

  it('asks again for a repository GitHub answered null because its resolver timed out, and never calls it missing', async () => {
    const partial = (names: string[]): GhRunResult => {
      const full = JSON.parse(answer(names).stdout)
      const i = names.indexOf('b')
      full.data[`r${i}`] = null
      full.errors = [{ path: [`r${i}`], message: 'Something went wrong while executing your query. This may be the result of a timeout.' }]
      return { stdout: JSON.stringify(full), stderr: 'GraphQL: Something went wrong', code: 1 }
    }
    const run = vi.fn<GhRunner>(async (args) => (asked(args).includes('b') && asked(args).length > 1 ? partial(asked(args)) : answer(asked(args))))
    const results = await new GitHubProvider(run, 0).list(repos('a', 'b', 'c'))
    expect(listed(results)).toEqual([['a', null, ['a']], ['b', null, ['b']], ['c', null, ['c']]])
    expect(run.mock.calls.map((c) => asked(c[0]))).toEqual([['a', 'b', 'c'], ['b']])
    // Alone and still timing out, it is an error of its own, not a repository to hide.
    const always = vi.fn<GhRunner>(async (args) => (asked(args).includes('b') ? partial(asked(args)) : answer(asked(args))))
    expect(listed(await new GitHubProvider(always, 0).list(repos('a', 'b')))).toEqual([['a', null, ['a']], ['b', 'unknown', []]])
  })

  it('asks for at most four repositories at once', async () => {
    const run = gh(ok(''), 99)
    await new GitHubProvider(run, 0).list(repos('a', 'b', 'c', 'd', 'e'))
    expect(run.mock.calls.map((c) => asked(c[0]).length)).toEqual([4, 1])
  })

  it('does not split a failure that is the whole host\'s', async () => {
    const run = vi.fn<GhRunner>().mockResolvedValue(fail('To get started with GitHub CLI, please run:  gh auth login'))
    await expect(new GitHubProvider(run, 0).list(repos('a', 'b'))).rejects.toMatchObject({ error: { kind: 'token_rejected' } })
    expect(run).toHaveBeenCalledTimes(1)
  })
})
