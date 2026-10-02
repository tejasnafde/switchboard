/**
 * The Reviews backend service: repositories from project remotes, one
 * account error per host, involvement filtering, and the guard that keeps a
 * client from pointing the host token at a repository that is not a project.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/logger', () => ({ createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))

import { involvesViewer, PullRequestService, type PullRequestServiceDeps } from '../../src/main/pull-requests/service'
import { PrHostError, type PullRequestProvider } from '../../src/main/pull-requests/provider'
import { rollupChecks, type PrSummary, type RepoRef } from '../../src/shared/pull-requests'

function summary(repo: RepoRef, number: number, viewer: Partial<PrSummary['viewer']>): PrSummary {
  return {
    ref: { ...repo, number }, title: `#${number}`, url: '', author: { login: 'a', displayName: 'a', avatarUrl: null },
    state: 'open', draft: false, sourceBranch: 'f', targetBranch: 'main', createdAt: 0, updatedAt: 0, mergedAt: null,
    additions: null, deletions: null, changedFiles: null, unresolvedConversations: 0, checks: rollupChecks([]),
    reviewers: [], approvals: { given: 0, required: null },
    viewer: { isAuthor: false, isRequestedReviewer: false, hasReviewed: false, hasCommented: false, ...viewer }, projectPaths: [],
  }
}

function provider(host: 'github' | 'bitbucket', impl: Partial<PullRequestProvider> = {}): PullRequestProvider {
  return {
    host,
    list: vi.fn(async (repos: RepoRef[]) => repos.map((repo) => ({ repo, prs: [summary(repo, 1, { isAuthor: true }), summary(repo, 2, {})], error: null }))),
    detail: vi.fn(async (ref) => ({ ...summary(ref, ref.number, {}), description: '', headSha: null, mergeBlockers: [], activity: [], checkList: [] })),
    files: vi.fn(async () => []),
    conversations: vi.fn(async () => []),
    checks: vi.fn(async () => []),
    ...impl,
  }
}

const REMOTES: Record<string, string> = {
  '/p/switchboard': 'origin\thttps://github.com/tejasnafde/switchboard.git (fetch)',
  '/p/switchboard-wt': 'origin\tgit@github.com:tejasnafde/switchboard.git (fetch)',
  '/p/bot': 'origin\tgit@bitbucket.org:geoiq/ssg-bot-v2.git (fetch)',
  '/p/local': '',
}

function deps(over: Partial<PullRequestServiceDeps> = {}): PullRequestServiceDeps {
  const gh = provider('github')
  const bb = provider('bitbucket')
  return {
    listProjects: () => Object.keys(REMOTES),
    readRemotes: async (path) => REMOTES[path],
    github: () => gh,
    bitbucket: () => bb,
    bitbucketState: () => ({ state: 'configured', email: 'me@example.com' }),
    ...over,
  }
}

describe('PullRequestService.list', () => {
  it('merges projects that share a repository and keeps only PRs that involve you', async () => {
    const result = await new PullRequestService(deps()).list()
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.unsupportedProjects).toEqual(['/p/local'])
    expect(result.data.sources.map((s) => [s.repo.name, s.projectPaths, s.error])).toEqual([
      ['switchboard', ['/p/switchboard', '/p/switchboard-wt'], null],
      ['ssg-bot-v2', ['/p/bot'], null],
    ])
    expect(result.data.prs.map((p) => `${p.ref.name}#${p.ref.number}`)).toEqual(['switchboard#1', 'ssg-bot-v2#1'])
    expect(result.data.prs[0].projectPaths).toEqual(['/p/switchboard', '/p/switchboard-wt'])
  })

  it('asks for a Bitbucket account without failing GitHub', async () => {
    const result = await new PullRequestService(deps({ bitbucket: () => null, bitbucketState: () => ({ state: 'unconfigured' }) })).list()
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.sources.find((s) => s.repo.host === 'bitbucket')?.error?.kind).toBe('no_account')
    expect(result.data.prs.every((p) => p.ref.host === 'github')).toBe(true)
  })

  it('says Bitbucket needs the desktop app on a backend with no keychain', async () => {
    const result = await new PullRequestService(deps({ bitbucket: () => null, bitbucketState: () => ({ state: 'needs_desktop' }) })).list()
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.sources.find((s) => s.repo.host === 'bitbucket')?.error?.kind).toBe('needs_desktop')
  })

  it('pins a host-wide failure (gh signed out) on each of that host\'s repositories', async () => {
    const gh = provider('github', { list: vi.fn(async () => { throw new PrHostError({ kind: 'token_rejected', host: 'github', message: 'signed out' }) }) })
    const result = await new PullRequestService(deps({ github: () => gh })).list()
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.sources.filter((s) => s.repo.host === 'github').map((s) => s.error?.kind)).toEqual(['token_rejected'])
    expect(result.data.prs.map((p) => p.ref.host)).toEqual(['bitbucket'])
  })

  it('does not read a hidden repository, and lists it as hidden', async () => {
    const d = deps({ hiddenRepos: () => new Set(['bitbucket:geoiq/ssg-bot-v2']) })
    const result = await new PullRequestService(d).list()
    if (!result.ok) throw new Error('expected ok')
    expect(d.bitbucket()?.list).not.toHaveBeenCalled()
    expect(result.data.sources.map((s) => s.repo.name)).toEqual(['switchboard'])
    expect(result.data.hiddenRepos).toEqual([{ host: 'bitbucket', owner: 'geoiq', name: 'ssg-bot-v2' }])
    expect(result.data.prs.map((p) => p.ref.host)).toEqual(['github'])
  })

  it('reads every repository when the hidden list cannot be read', async () => {
    const result = await new PullRequestService(deps({ hiddenRepos: () => { throw new Error('db locked') } })).list()
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.sources).toHaveLength(2)
    expect(result.data.hiddenRepos).toEqual([])
  })

  it('re-reads remotes at most every 5 minutes', async () => {
    let now = 0
    const readRemotes = vi.fn(async (path: string) => REMOTES[path])
    const service = new PullRequestService(deps({ readRemotes, now: () => now }))
    await service.list()
    await service.list()
    expect(readRemotes).toHaveBeenCalledTimes(4)
    now = 5 * 60_000
    await service.list()
    expect(readRemotes).toHaveBeenCalledTimes(8)
  })
})

describe('involvesViewer', () => {
  const repo: RepoRef = { host: 'bitbucket', owner: 'geoiq', name: 'retail-api' }

  it.each([
    ['yours', { isAuthor: true }, true],
    ['asked to review', { isRequestedReviewer: true }, true],
    ['reviewed', { hasReviewed: true }, true],
    ['only commented', { hasCommented: true }, true],
    ['not yours at all', {}, false],
  ])('%s -> %s', (_name, viewer, kept) => {
    expect(involvesViewer(summary(repo, 676, viewer))).toBe(kept)
  })

  it('lists a PR you only commented on', async () => {
    const bb = provider('bitbucket', { list: vi.fn(async (repos: RepoRef[]) => repos.map((r) => ({ repo: r, prs: [summary(r, 676, { hasCommented: true })], error: null }))) })
    const result = await new PullRequestService(deps({ bitbucket: () => bb })).list()
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.prs.filter((p) => p.ref.host === 'bitbucket').map((p) => p.ref.number)).toEqual([676])
  })
})

describe('PullRequestService reads', () => {
  it('reads a PR in one of the projects and tags it with those projects', async () => {
    const result = await new PullRequestService(deps()).detail({ host: 'github', owner: 'TejasNafde', name: 'Switchboard', number: 7 })
    expect(result.ok && result.data.projectPaths).toEqual(['/p/switchboard', '/p/switchboard-wt'])
  })

  it('refuses a repository that is not a project, and junk references', async () => {
    const d = deps()
    const service = new PullRequestService(d)
    expect(await service.files({ host: 'github', owner: 'someone', name: 'else', number: 1 })).toMatchObject({ ok: false, error: { kind: 'unsupported_repo' } })
    expect(await service.checks({ host: 'gitlab', owner: 'a', name: 'b', number: 1 })).toMatchObject({ ok: false })
    expect(await service.conversations({ host: 'github', owner: 'tejasnafde', name: 'switchboard', number: -1 })).toMatchObject({ ok: false })
    expect(await service.conversations(null)).toMatchObject({ ok: false })
    expect(d.github().files).not.toHaveBeenCalled()
  })

  it('turns a provider failure into a result', async () => {
    const gh = provider('github', { checks: vi.fn(async () => { throw new PrHostError({ kind: 'rate_limited', host: 'github', message: 'slow down' }) }) })
    const result = await new PullRequestService(deps({ github: () => gh })).checks({ host: 'github', owner: 'tejasnafde', name: 'switchboard', number: 3 })
    expect(result).toEqual({ ok: false, error: { kind: 'rate_limited', host: 'github', message: 'slow down' } })
  })
})

describe('PullRequestService: a project folder that holds several repositories', () => {
  const ssg: Record<string, string> = {
    '/w/ssg': '',
    '/w/ssg/core': 'origin\tgit@bitbucket.org:geoiq/geoiq-ssg-core-v1.git (fetch)',
    '/w/ssg/apps/studio': 'origin\thttps://bitbucket.org/geoiq/geoiq-ssg-studio-v1.git (fetch)',
    '/w/ssg/scratch': '',
    '/p/switchboard': REMOTES['/p/switchboard'],
  }
  const children: Record<string, string[]> = {
    '/w/ssg': ['/w/ssg/core', '/w/ssg/apps/studio', '/w/ssg/scratch'],
    '/p/switchboard': ['/p/switchboard/vendor/lib'],
  }
  const ssgDeps = (over: Partial<PullRequestServiceDeps> = {}) => deps({
    listProjects: () => ['/w/ssg', '/p/switchboard'],
    readRemotes: async (path) => ssg[path] ?? '',
    scanChildRepos: vi.fn(async (path: string) => children[path] ?? []),
    ...over,
  })

  it('covers the child repositories that have a supported remote, under the parent project', async () => {
    const d = ssgDeps()
    const service = new PullRequestService(d)
    const project = await service.projectRepos('/w/ssg')
    expect(project.own).toBeNull()
    expect(project.children.map((c) => [c.relPath, c.repo.name])).toEqual([['core', 'geoiq-ssg-core-v1'], ['apps/studio', 'geoiq-ssg-studio-v1']])
    const result = await service.list()
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.sources.map((s) => [s.repo.name, s.projectPaths])).toEqual([
      ['switchboard', ['/p/switchboard']],
      ['geoiq-ssg-core-v1', ['/w/ssg']],
      ['geoiq-ssg-studio-v1', ['/w/ssg']],
    ])
    expect(result.data.unsupportedProjects).toEqual([])
    // A project that is a repository is never scanned.
    expect(d.scanChildRepos).not.toHaveBeenCalledWith('/p/switchboard')
  })

  it('reads and writes a child repository, as one of the projects', async () => {
    const service = new PullRequestService(ssgDeps())
    const detail = await service.detail({ host: 'bitbucket', owner: 'geoiq', name: 'geoiq-ssg-core-v1', number: 4 })
    expect(detail.ok).toBe(true)
    if (detail.ok) expect(detail.data.projectPaths).toEqual(['/w/ssg'])
    const other = await service.detail({ host: 'bitbucket', owner: 'geoiq', name: 'elsewhere', number: 4 })
    expect(other.ok === false && other.error.kind).toBe('unsupported_repo')
  })

  it('scans a folder once per window, however many reads ask at once', async () => {
    let now = 0
    const d = ssgDeps({ now: () => now })
    const service = new PullRequestService(d)
    await Promise.all([service.detect(), service.detect(), service.projectRepos('/w/ssg')])
    expect(d.scanChildRepos).toHaveBeenCalledTimes(1)
    now += 61_000
    await service.detect()
    expect(d.scanChildRepos).toHaveBeenCalledTimes(2)
  })

  it('keeps a folder whose scan fails, or finds nothing, as unsupported', async () => {
    const result = await new PullRequestService(ssgDeps({ scanChildRepos: async () => { throw new Error('EACCES') } })).list()
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.unsupportedProjects).toEqual(['/w/ssg'])
  })
})
