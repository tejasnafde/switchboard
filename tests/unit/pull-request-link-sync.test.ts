/**
 * Branch detection and link state: a chat whose branch has an open PR on the
 * chat's repository links it (cached, so a turn end is not a host call), and
 * a link re-reads its PR state after a shell merge or close, or when its
 * stored state is old.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/logger', () => ({ createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))

import { PullRequestLinkSync, type LinkSyncDeps } from '../../src/main/pull-requests/link-sync'
import { projectReposFrom } from '../../src/shared/project-repos'
import type { PrLink } from '../../src/shared/pull-request-links'
import type { PrRef, PrState, RepoRef } from '../../src/shared/pull-requests'
import type { RuntimeEvent } from '../../src/shared/provider-events'

const APP: RepoRef = { host: 'github', owner: 'acme', name: 'app' }
const LIB: RepoRef = { host: 'github', owner: 'acme', name: 'lib' }

function setup(over: Partial<LinkSyncDeps> = {}) {
  let now = 1_000_000
  const links: PrLink[] = []
  const notified: string[] = []
  const problems: string[] = []
  const states = new Map<number, PrState>()
  const deps: LinkSyncDeps = {
    conversationFor: (threadId) => (threadId === 'missing' ? null : { id: 'root', projectPath: '/p', cwd: '/p/wt' }),
    projectRepos: async () => projectReposFrom(APP, []),
    reposFor: async () => [APP],
    currentBranch: vi.fn(async () => 'feat/x'),
    openPullRequestFor: vi.fn(async () => ({ ok: true as const, data: { number: 7, url: 'https://github.com/acme/app/pull/7' } })),
    linkedPrs: () => links,
    link: vi.fn((_chat: string, ref: PrRef) => {
      if (links.some((l) => l.ref.number === ref.number)) return false
      links.push({ ref, source: 'auto', linkedAt: now })
      return true
    }),
    prState: vi.fn(async (ref: PrRef) => ({ ok: true as const, data: states.get(ref.number) ?? 'open' as PrState })),
    setState: vi.fn((ref: PrRef, state: PrState) => {
      const hit = links.find((l) => l.ref.number === ref.number)
      if (!hit) return []
      const changed = hit.state !== state
      Object.assign(hit, { state, stateAt: now })
      return changed ? ['root'] : []
    }),
    notify: (id) => notified.push(id),
    problem: (_id, message) => problems.push(message),
    now: () => now,
    ...over,
  }
  return { sync: new PullRequestLinkSync(deps), deps, links, notified, problems, states, tick: (ms: number) => { now += ms } }
}

const turnDone = { type: 'turn.completed', threadId: 't1' } as RuntimeEvent
const started = { type: 'session.provider', threadId: 't1', provider: 'codex', instanceId: null, instanceName: null } as RuntimeEvent
const tool = (command: string): RuntimeEvent => ({ type: 'tool.started', threadId: 't1', toolCallId: 'c1', toolName: 'Bash', input: { command } }) as RuntimeEvent
const toolDone = { type: 'tool.completed', threadId: 't1', toolCallId: 'c1', output: 'done' } as RuntimeEvent

describe('branch detection', () => {
  it("links the open PR of the chat's branch at session start, as an automatic link", async () => {
    const { sync, deps, links, notified } = setup()
    await sync.onEvent(started)
    expect(deps.currentBranch).toHaveBeenCalledWith('/p/wt')
    expect(deps.openPullRequestFor).toHaveBeenCalledWith(APP, 'feat/x')
    expect(links.map((l) => l.ref)).toEqual([{ ...APP, number: 7 }])
    expect(notified).toEqual(['root'])
  })

  it('asks the host once per repository and branch within the cache window', async () => {
    const { sync, deps, tick } = setup()
    await sync.onEvent(started)
    await sync.onEvent(turnDone)
    await sync.onEvent(turnDone)
    expect(deps.openPullRequestFor).toHaveBeenCalledTimes(1)
    tick(6 * 60_000)
    await sync.onEvent(turnDone)
    expect(deps.openPullRequestFor).toHaveBeenCalledTimes(2)
  })

  it('a second chat on the same branch links the same PR from the cache', async () => {
    const { sync, deps, links } = setup()
    await sync.onEvent(started)
    links.length = 0
    await sync.onEvent({ ...started, threadId: 't2' } as RuntimeEvent)
    expect(deps.openPullRequestFor).toHaveBeenCalledTimes(1)
    expect(links).toHaveLength(1)
  })

  it('never links when the checkout points at a repository the project does not cover', async () => {
    const { sync, deps, links } = setup({ reposFor: async () => [LIB] })
    await sync.onEvent(turnDone)
    expect(deps.openPullRequestFor).not.toHaveBeenCalled()
    expect(links).toEqual([])
  })

  it('does nothing on a detached HEAD or for a thread with no chat', async () => {
    const { sync, deps } = setup({ currentBranch: vi.fn(async () => null) })
    await sync.onEvent(turnDone)
    await sync.onEvent({ ...turnDone, threadId: 'missing' } as RuntimeEvent)
    expect(deps.openPullRequestFor).not.toHaveBeenCalled()
  })

  it('reports a host failure as a problem the agent can read, and retries it a minute later, not every turn', async () => {
    const openPullRequestFor = vi.fn(async () => ({ ok: false as const, error: { kind: 'offline' as const, host: 'github' as const, message: 'GitHub is unreachable.' } }))
    const { sync, problems, tick } = setup({ openPullRequestFor })
    await sync.onEvent(turnDone)
    await sync.onEvent(turnDone)
    expect(problems[0]).toContain('GitHub is unreachable.')
    expect(openPullRequestFor).toHaveBeenCalledTimes(1)
    tick(61_000)
    await sync.onEvent(turnDone)
    expect(openPullRequestFor).toHaveBeenCalledTimes(2)
  })
})

describe('link state', () => {
  it('re-reads every open link after a shell merge or close, whatever the cache says', async () => {
    const { sync, deps, links, states, notified } = setup({ currentBranch: vi.fn(async () => null) })
    links.push({ ref: { ...APP, number: 9 }, source: 'manual', linkedAt: 0, state: 'open', stateAt: 999_999 })
    states.set(9, 'merged')
    await sync.onEvent(tool('gh pr merge 9 --merge'))
    expect(deps.prState).not.toHaveBeenCalled()
    await sync.onEvent(toolDone)
    expect(deps.prState).toHaveBeenCalledWith({ ...APP, number: 9 })
    expect(links[0].state).toBe('merged')
    expect(notified).toEqual(['root'])
  })

  it('refreshes an old state at turn end, and leaves a fresh or finished one alone', async () => {
    const { sync, deps, links, tick } = setup({ currentBranch: vi.fn(async () => null) })
    links.push({ ref: { ...APP, number: 1 }, source: 'auto', linkedAt: 0 })
    links.push({ ref: { ...APP, number: 2 }, source: 'auto', linkedAt: 0, state: 'merged', stateAt: 0 })
    await sync.onEvent(turnDone)
    expect((deps.prState as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].number)).toEqual([1])
    await sync.onEvent(turnDone)
    expect(deps.prState).toHaveBeenCalledTimes(1)
    tick(16 * 60_000)
    await sync.onEvent(turnDone)
    expect(deps.prState).toHaveBeenCalledTimes(2)
  })

  it('a failed state read is a problem, not a crash', async () => {
    const { sync, links, problems } = setup({
      currentBranch: vi.fn(async () => null),
      prState: vi.fn(async () => ({ ok: false as const, error: { kind: 'unknown' as const, host: 'github' as const, message: 'boom' } })),
    })
    links.push({ ref: { ...APP, number: 1 }, source: 'auto', linkedAt: 0 })
    await sync.onEvent(turnDone)
    expect(problems).toEqual(['Could not read the state of acme/app #1: boom'])
  })
})
