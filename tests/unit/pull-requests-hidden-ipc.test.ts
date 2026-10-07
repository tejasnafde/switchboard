/**
 * Hide from Reviews, through the IPC handlers over the demo pull requests:
 * the list marks what is hidden, clears a hide whose PR came back
 * (`hiddenComesBack`), and the hide channels refuse anything but a PR ref.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { hidden, unhideKeys, hide, hiddenRepos, hideRepos, unhideRepos, linkedKeys, setLinkState } = vi.hoisted(() => {
  process.env.SB_DEMO_ADAPTER = '1'
  process.env.SB_DEMO_REPO_ERRORS = '1'
  return {
    hidden: new Map<string, number>(), unhideKeys: vi.fn(), hide: vi.fn(), hiddenRepos: new Set<string>(), hideRepos: vi.fn(), unhideRepos: vi.fn(),
    linkedKeys: new Set<string>(), setLinkState: vi.fn((..._args: unknown[]): string[] => []),
  }
})

vi.mock('../../src/main/logger', () => ({ createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))
vi.mock('../../src/main/shell-env', () => ({ childProcessEnv: () => process.env }))
vi.mock('../../src/main/runtime', () => ({ userDataDir: () => '/nonexistent', getSafeStorage: () => null }))
vi.mock('../../src/main/db/database', () => ({
  getProjects: () => [],
  listHiddenPullRequests: () => hidden,
  unhidePullRequestKeys: unhideKeys,
  hidePullRequest: hide,
  unhidePullRequest: vi.fn(),
  listHiddenPullRequestRepos: () => hiddenRepos,
  hidePullRequestRepos: hideRepos,
  unhidePullRequestRepos: unhideRepos,
  linkedPullRequestKeys: () => linkedKeys,
  setPullRequestLinkState: setLinkState,
}))

import { registerPullRequestHandlers } from '../../src/main/ipc/pull-requests'
import { PullRequestChannels } from '../../src/shared/ipc-channels'
import { prKey, type PrListData, type PrRef, type PrResult } from '../../src/shared/pull-requests'

function handlers() {
  const map = new Map<string, (...args: unknown[]) => unknown>()
  registerPullRequestHandlers({ handle: (channel, fn) => { map.set(channel, fn as never) }, on: vi.fn(), emit: vi.fn() })
  return map
}

const BOT = 'bitbucket:geoiq/ssg-bot-v2#612'
const RETAIL = 'bitbucket:geoiq/retailiq#88'

beforeEach(() => {
  hidden.clear()
  unhideKeys.mockClear()
  hide.mockClear()
  hiddenRepos.clear()
  hideRepos.mockReset()
  unhideRepos.mockReset()
  linkedKeys.clear()
  setLinkState.mockClear()
})

describe('pull-requests:list with hidden PRs', () => {
  it('marks a quiet hidden PR and clears one that changed and needs you', async () => {
    const longAgo = Date.now() - 30 * 24 * 3_600_000
    hidden.set(BOT, longAgo) // updated since, and its conflicts are on you
    hidden.set(RETAIL, longAgo) // updated since, but only waiting on others
    const result = await handlers().get(PullRequestChannels.LIST)!() as PrResult<PrListData>
    expect(result.ok && result.data.hidden).toEqual([RETAIL])
    expect(unhideKeys).toHaveBeenCalledWith([BOT])
  })

  it('keeps a PR hidden that has not changed since', async () => {
    hidden.set(BOT, Date.now() + 60_000)
    const result = await handlers().get(PullRequestChannels.LIST)!() as PrResult<PrListData>
    expect(result.ok && result.data.hidden).toEqual([BOT])
    expect(unhideKeys).not.toHaveBeenCalled()
  })
})

describe('pull-requests:list link state', () => {
  it('stores the state only of PRs a chat links', async () => {
    linkedKeys.add(BOT)
    const result = await handlers().get(PullRequestChannels.LIST)!() as PrResult<PrListData>
    expect(result.ok && result.data.prs.length).toBeGreaterThan(1)
    expect(setLinkState.mock.calls.map(([ref]) => prKey(ref as PrRef))).toEqual([BOT])
  })

  it('dates the stored state from when the read started, so it never outranks a later write', async () => {
    linkedKeys.add(BOT)
    const before = Date.now()
    const result = await handlers().get(PullRequestChannels.LIST)!() as PrResult<PrListData>
    if (!result.ok) throw new Error('expected ok')
    const observedAt = (setLinkState.mock.calls[0] as unknown[])[2] as number
    expect(observedAt).toBeGreaterThanOrEqual(before)
    expect(observedAt).toBeLessThanOrEqual(result.data.fetchedAt)
  })
})

describe('pull-requests:hide', () => {
  it('stores a pull request and refuses anything else', async () => {
    const h = handlers().get(PullRequestChannels.HIDE)!
    const ref = { host: 'github', owner: 'tejasnafde', name: 'switchboard', number: 161 }
    expect(h(ref)).toEqual({ ok: true })
    expect(hide).toHaveBeenCalledWith(ref)
    expect(h({ host: 'gitlab', owner: 'x', name: 'y', number: 1 })).toMatchObject({ ok: false })
    expect(hide).toHaveBeenCalledTimes(1)
  })
})

describe('hidden repositories', () => {
  const STAGING = [
    { host: 'bitbucket', owner: 'geoiq-staging', name: 'geoiq_broker_app_stg' },
    { host: 'bitbucket', owner: 'geoiq-staging', name: 'geoiqcore_stg' },
  ]

  it('lists the repositories the account cannot see, then stops reading them once hidden', async () => {
    const list = handlers().get(PullRequestChannels.LIST)!
    const before = await list() as PrResult<PrListData>
    if (!before.ok) throw new Error('expected ok')
    const failing = before.data.sources.filter((s) => s.error).map((s) => [s.repo.name, s.error?.kind])
    expect(failing).toEqual([['geoiq_broker_app_stg', 'not_found'], ['geoiqcore_stg', 'not_found']])

    for (const repo of STAGING) hiddenRepos.add(`bitbucket:${repo.owner}/${repo.name}`)
    const after = await list() as PrResult<PrListData>
    if (!after.ok) throw new Error('expected ok')
    expect(after.data.sources.some((s) => s.error)).toBe(false)
    expect(after.data.hiddenRepos).toEqual(STAGING)
  })

  it('stores and clears a valid list, and refuses anything else', async () => {
    const map = handlers()
    expect(map.get(PullRequestChannels.HIDE_REPOS)!(STAGING)).toEqual({ ok: true })
    expect(hideRepos).toHaveBeenCalledWith(STAGING)
    expect(map.get(PullRequestChannels.UNHIDE_REPOS)!([STAGING[0]])).toEqual({ ok: true })
    expect(unhideRepos).toHaveBeenCalledWith([STAGING[0]])
    expect(map.get(PullRequestChannels.HIDE_REPOS)!([{ host: 'gitlab', owner: 'a', name: 'b' }])).toMatchObject({ ok: false })
    expect(map.get(PullRequestChannels.HIDE_REPOS)!([])).toMatchObject({ ok: false })
    expect(hideRepos).toHaveBeenCalledTimes(1)
  })

  it('answers a failed save with a reason instead of throwing', () => {
    hideRepos.mockImplementation(() => { throw new Error('SQLITE_BUSY') })
    expect(handlers().get(PullRequestChannels.HIDE_REPOS)!(STAGING)).toEqual({ ok: false, message: 'Could not save that; see the log.' })
  })
})
