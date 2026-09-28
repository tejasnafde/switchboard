/**
 * GitHub answers a read with a transient 5xx now and then (a 502 on the list
 * query, five times in one user's ten hours). A read is tried once more after
 * a pause; a write never is, and neither is a 404 or a signed-out gh. Fake gh
 * only, no network.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/logger', () => ({ createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))
vi.mock('../../src/main/shell-env', () => ({ childProcessEnv: () => ({}) }))

import { isTransientGhFailure } from '../../src/main/pull-requests/github-map'
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
    ['gh: Not Found (HTTP 404)', false],
    ['To get started with GitHub CLI, please run:  gh auth login', false],
    ['API rate limit exceeded (HTTP 403)', false],
  ])('%s -> %s', (stderr, transient) => {
    expect(isTransientGhFailure(fail(stderr))).toBe(transient)
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

  it('retries only once, then fails as before', async () => {
    const run = vi.fn<GhRunner>().mockResolvedValue(fail('gh: HTTP 502'))
    await expect(new GitHubProvider(run, 0).list([repo])).rejects.toMatchObject({ error: { kind: 'unknown', message: 'gh: HTTP 502' } })
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
