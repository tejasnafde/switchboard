import { describe, expect, it, vi } from 'vitest'
import type { RepoRef, PrRef } from '../../src/shared/pull-requests'
import {
  MAX_HISTORY_SCAN_CHARS,
  scanPendingPullRequestHistory,
  scanPullRequestHistoryForConversation,
  HistoryReadError,
  type PullRequestHistoryScanDeps,
  type PullRequestHistoryScanTarget,
} from '../../src/main/pull-requests/history-scan'
import type { HistoryPartKind } from '../../src/main/pull-requests/history-source'
import { historyScanSummary } from '../../src/shared/pull-request-links'
import { projectReposFrom } from '../../src/shared/project-repos'

vi.mock('../../src/main/logger', () => ({ createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))

const BOT: RepoRef = { host: 'bitbucket', owner: 'geoiq', name: 'ssg-bot-v2' }
const SB: RepoRef = { host: 'github', owner: 'tejasnafde', name: 'switchboard' }
const TARGET: PullRequestHistoryScanTarget = { id: 'agent_1', projectPath: '/repo' }
const BOT_605 = 'https://bitbucket.org/geoiq/ssg-bot-v2/pull-requests/605'

type Part = [HistoryPartKind, string]
type TestDeps = PullRequestHistoryScanDeps & { linked: PrRef[]; visited: Part[] }

function deps(parts: Part[], repo: RepoRef | null = BOT): TestDeps {
  const linked: PrRef[] = []
  const visited: Part[] = []
  const d = {
    listUnscanned: vi.fn(() => [TARGET]),
    readHistory: vi.fn(async (_id, visit) => {
      for (const part of parts) {
        visited.push(part)
        if (!visit(...part)) return
      }
    }),
    repoForProject: vi.fn(async () => repo),
    link: vi.fn((_id, ref) => {
      linked.push(ref)
      return true
    }),
    notify: vi.fn(),
    markScanned: vi.fn(),
    linked,
    visited,
  }
  return { ...d, projectRepos: ownRepoOf(d) }
}

/** The project's own repository through the `repoForProject` mock, so a test that re-mocks it drives both. */
function ownRepoOf(d: Pick<PullRequestHistoryScanDeps, 'repoForProject'>): PullRequestHistoryScanDeps['projectRepos'] {
  return vi.fn(async (path: string) => projectReposFrom(await d.repoForProject(path), []))
}

function pendingDeps(ids: string[], overrides: Partial<PullRequestHistoryScanDeps> = {}): PullRequestHistoryScanDeps & { scanned: Set<string> } {
  const scanned = new Set<string>()
  const d = {
    scanned,
    listUnscanned: vi.fn((limit) => ids.filter((id) => !scanned.has(id)).slice(0, limit).map((id) => ({ id, projectPath: '/repo' }))),
    readHistory: vi.fn(async () => {}),
    repoForProject: vi.fn(async () => BOT),
    link: vi.fn(() => true),
    notify: vi.fn(),
    markScanned: vi.fn((id: string) => { scanned.add(id) }),
    ...overrides,
  }
  return { ...d, projectRepos: overrides.projectRepos ?? ownRepoOf(d) }
}

describe('pull request history scan', () => {
  it('links the PR gh pr create printed, and no other tool output', async () => {
    const d = deps([
      ['toolInput', '{"command":"cat CHANGELOG.md"}'],
      ['toolOutput', '- fixed in https://github.com/tejasnafde/switchboard/pull/611'],
      ['toolInput', '{"command":"gh pr create --fill"}'],
      ['toolOutput', 'https://github.com/tejasnafde/switchboard/pull/612\n'],
    ], SB)

    const result = await scanPullRequestHistoryForConversation(TARGET, d)

    expect(d.linked).toEqual([{ ...SB, number: 612 }])
    expect(d.notify).toHaveBeenCalledWith('agent_1')
    expect(d.markScanned).toHaveBeenCalledWith('agent_1')
    expect(result).toMatchObject({ linked: 1, capped: false })
  })

  it('links a PR URL in a tool input', async () => {
    const d = deps([['toolInput', JSON.stringify({ command: `cd /repo &&\nbbpr ${BOT_605} diff` }, null, 2)]])

    await scanPullRequestHistoryForConversation(TARGET, d)

    expect(d.linked).toEqual([{ ...BOT, number: 605 }])
  })

  it('links a bare bbpr number in a tool input to the Bitbucket project', async () => {
    const d = deps([['toolInput', JSON.stringify({ command: 'cd /repo && bbpr 605 diff', description: 'Show the diff' })]])

    await scanPullRequestHistoryForConversation(TARGET, d)

    expect(d.linked).toEqual([{ ...BOT, number: 605 }])
  })

  it('links a bare bbpr number only when the command runs in the chat repository', async () => {
    const other: RepoRef = { host: 'bitbucket', owner: 'geoiq', name: 'retailiq' }
    const d = deps([
      ['toolInput', JSON.stringify({ command: 'cd /other/repo && bbpr 605 diff' })],
      ['toolInput', JSON.stringify({ command: 'cd ~/elsewhere && bbpr 606' })],
      ['toolInput', JSON.stringify({ command: 'cd sub && bbpr 607' })],
      ['toolInput', JSON.stringify({ command: 'bbpr 608' })],
    ])
    vi.mocked(d.repoForProject).mockImplementation(async (path) => (path === '/other/repo' ? other : BOT))

    await scanPullRequestHistoryForConversation(TARGET, d)

    // 605 ran in retailiq, 606 behind an unresolvable cd; 607 in /repo/sub, 608 in the chat's cwd.
    expect(d.linked.map((r) => r.number)).toEqual([607, 608])
    expect(d.repoForProject).toHaveBeenCalledWith('/repo/sub')
  })

  it("resolves a relative cd and a bare bbpr against the chat's worktree", async () => {
    const d = deps([['toolInput', JSON.stringify({ command: 'cd .. && bbpr 605' })], ['toolInput', '{"command":"bbpr 606"}']])
    vi.mocked(d.repoForProject).mockImplementation(async (path) => (path === '/repo/.switchboard/worktrees' ? null : BOT))

    await scanPullRequestHistoryForConversation({ ...TARGET, worktreePath: '/repo/.switchboard/worktrees/x' }, d)

    expect(d.linked.map((r) => r.number)).toEqual([606])
  })

  it('ignores a bare bbpr number in chat text, and on a GitHub project', async () => {
    const text = deps([['text', 'bbpr 605 diff'], ['toolOutput', 'bbpr 606']])
    await scanPullRequestHistoryForConversation(TARGET, text)
    expect(text.link).not.toHaveBeenCalled()

    const github = deps([['toolInput', '{"command":"bbpr 605"}']], SB)
    await scanPullRequestHistoryForConversation(TARGET, github)
    expect(github.link).not.toHaveBeenCalled()
  })

  it('does not link a PR only named in chat text or read, and ignores one from another repository', async () => {
    const d = deps([
      ['text', 'tracked in https://github.com/tejasnafde/switchboard/pull/612'],
      ['toolInput', '{"command":"gh pr view https://github.com/tejasnafde/switchboard/pull/613"}'],
      ['toolInput', `{"command":"gh pr checkout ${BOT_605}"}`],
      ['toolInput', '{"command":"gh pr checkout https://github.com/tejasnafde/switchboard/pull/614"}'],
    ], SB)

    await scanPullRequestHistoryForConversation(TARGET, d)

    expect(d.linked).toEqual([{ ...SB, number: 614 }])
  })

  it('does not revive an unlinked tombstone', async () => {
    const d = deps([['text', `Closed ${BOT_605} earlier.`], ['toolInput', '{"command":"bbpr 605"}']])
    vi.mocked(d.link).mockReturnValue(false)

    const result = await scanPullRequestHistoryForConversation(TARGET, d)

    expect(d.link).toHaveBeenCalledOnce()
    expect(d.notify).not.toHaveBeenCalled()
    expect(result.linked).toBe(0)
  })

  it('marks a conversation scanned so the pending scan only reads it once', async () => {
    const d = pendingDeps([TARGET.id])

    await scanPendingPullRequestHistory(d, { batchSize: 10, concurrency: 1, yieldMs: 0 })
    await scanPendingPullRequestHistory(d, { batchSize: 10, concurrency: 1, yieldMs: 0 })

    expect(d.readHistory).toHaveBeenCalledOnce()
    expect(d.markScanned).toHaveBeenCalledOnce()
  })
})

describe('the character cap', () => {
  it('stops reading at the cap and says the chat was only partly read', async () => {
    const d = deps([['text', 'a'.repeat(MAX_HISTORY_SCAN_CHARS + 10_000)], ['text', BOT_605]])

    const result = await scanPullRequestHistoryForConversation(TARGET, d)

    expect(d.visited).toHaveLength(1)
    expect(d.link).not.toHaveBeenCalled()
    expect(result.capped).toBe(true)
    expect(result.scannedChars).toBe(MAX_HISTORY_SCAN_CHARS)
  })

  it('reports a partial read when text follows a part that fills the cap exactly', async () => {
    const d = deps([['text', 'a'.repeat(MAX_HISTORY_SCAN_CHARS)], ['text', 'more']])

    const result = await scanPullRequestHistoryForConversation(TARGET, d)

    expect(result.capped).toBe(true)
  })

  it('does not report a partial read when a chat fills the cap exactly and ends', async () => {
    const d = deps([['text', 'a'.repeat(MAX_HISTORY_SCAN_CHARS)], ['text', '  ']])

    expect((await scanPullRequestHistoryForConversation(TARGET, d)).capped).toBe(false)
  })

  it('never links a PR number the cap cut short', async () => {
    const command = 'gh pr checkout https://github.com/tejasnafde/switchboard/pull/612'
    const cutAfter6 = command.length - 2
    const d = deps([['text', 'a'.repeat(MAX_HISTORY_SCAN_CHARS - cutAfter6)], ['toolInput', command]], SB)

    await scanPullRequestHistoryForConversation(TARGET, d)

    expect(d.link).not.toHaveBeenCalled()
  })

  it('never takes a bbpr number the cap cut short', async () => {
    const command = 'bbpr 605'
    const d = deps([['text', 'a'.repeat(MAX_HISTORY_SCAN_CHARS - command.length + 2)], ['toolInput', command]])

    await scanPullRequestHistoryForConversation(TARGET, d)

    expect(d.link).not.toHaveBeenCalled()
  })

  it('counts text repeated by another source once', async () => {
    const d = deps([['text', 'a'.repeat(MAX_HISTORY_SCAN_CHARS / 2 + 1)], ['text', 'a'.repeat(MAX_HISTORY_SCAN_CHARS / 2 + 1)], ['toolInput', `bbpr ${BOT_605}`]])

    const result = await scanPullRequestHistoryForConversation(TARGET, d)

    expect(result.capped).toBe(false)
    expect(d.linked).toEqual([{ ...BOT, number: 605 }])
  })
})

describe('the pending scan', () => {
  it('works through every batch until no chat is left', async () => {
    const ids = Array.from({ length: 5 }, (_, i) => `agent_${i}`)
    const d = pendingDeps(ids)

    const results = await scanPendingPullRequestHistory(d, { batchSize: 2, concurrency: 2, yieldMs: 0 })

    expect(results.map((r) => r.conversationId).sort()).toEqual(ids)
    expect(d.repoForProject).not.toHaveBeenCalled()
  })

  it('pages past a chat that could not be marked', async () => {
    const ids = ['stuck', 'agent_1', 'agent_2', 'agent_3']
    const d = pendingDeps(ids)
    vi.mocked(d.markScanned).mockImplementation((id) => {
      if (id === 'stuck') throw new Error('disk full')
      d.scanned.add(id)
    })

    const results = await scanPendingPullRequestHistory(d, { batchSize: 1, concurrency: 1, yieldMs: 0 })

    expect(results.map((r) => r.conversationId)).toEqual(ids)
    expect(d.readHistory).toHaveBeenCalledTimes(4)
  })

  it('leaves a chat unmarked when the repository lookup or a link fails, so a later run retries it', async () => {
    const d = pendingDeps(['lookup', 'link', 'agent_1'])
    vi.mocked(d.readHistory).mockImplementation(async (id, visit) => {
      visit('toolInput', id === 'agent_1' ? 'nothing here' : `bbpr ${BOT_605}`)
    })
    vi.mocked(d.repoForProject).mockImplementation(async () => {
      if (vi.mocked(d.repoForProject).mock.calls.length === 1) throw new Error('git remote failed')
      return BOT
    })
    vi.mocked(d.link).mockImplementation(() => { throw new Error('database is locked') })

    const results = await scanPendingPullRequestHistory(d, { batchSize: 10, concurrency: 1, yieldMs: 0 })

    expect(results.map((r) => r.conversationId)).toEqual(['agent_1'])
    expect([...d.scanned]).toEqual(['agent_1'])
    expect(d.readHistory).toHaveBeenCalledTimes(3)
  })

  it('marks a chat whose history cannot be read, and records the problem for the agent', async () => {
    const d = pendingDeps(['unreadable'])
    const problem = vi.fn()
    vi.mocked(d.readHistory).mockRejectedValue(new Error('EACCES'))

    await scanPendingPullRequestHistory({ ...d, problem }, { yieldMs: 0 })

    expect([...d.scanned]).toEqual(['unreadable'])
    expect(problem).toHaveBeenCalledWith('unreadable', expect.stringContaining('EACCES'))
  })

  it('does not mark a chat when a manual scan cannot read it', async () => {
    const d = pendingDeps(['unreadable'])
    vi.mocked(d.readHistory).mockRejectedValue(new Error('EACCES'))

    await expect(scanPullRequestHistoryForConversation({ id: 'unreadable', projectPath: '/repo' }, d)).rejects.toBeInstanceOf(HistoryReadError)
    expect(d.markScanned).not.toHaveBeenCalled()
  })

  it('keeps going when a chat can be neither read nor marked', async () => {
    const d = pendingDeps(['bad', 'agent_1', 'agent_2'])
    vi.mocked(d.readHistory).mockImplementation(async (id) => {
      if (id === 'bad') throw new Error('unreadable')
    })
    vi.mocked(d.markScanned).mockImplementation((id) => {
      if (id === 'bad') throw new Error('disk full')
      d.scanned.add(id)
    })

    const results = await scanPendingPullRequestHistory(d, { batchSize: 2, concurrency: 2, yieldMs: 0 })

    expect(results.map((r) => r.conversationId).sort()).toEqual(['agent_1', 'agent_2'])
    expect(d.markScanned).toHaveBeenCalledWith('bad')
  })
})

describe('historyScanSummary', () => {
  it('names the count and says when a long chat was only partly read', () => {
    expect(historyScanSummary({ ok: true, linked: 2, capped: true, capChars: 250_000 })).toEqual({
      title: 'Linked 2 pull requests',
      body: "Only pull requests of this chat's project repository are linked, and one you unlinked stays unlinked. This chat is long, so only its first 250,000 characters were read.",
    })
    expect(historyScanSummary({ ok: true, linked: 0, capped: false, capChars: 250_000 }).title).toBe('No new pull requests found')
    expect(historyScanSummary({ ok: false, message: 'Not a chat.' })).toEqual({ title: 'Could not scan this chat', body: 'Not a chat.' })
  })
})
