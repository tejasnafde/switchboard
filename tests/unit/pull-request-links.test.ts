import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/logger', () => ({ createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))

import { autoLinkRefs, canLinkToProject, findPullRequestUrls, isPrRef, linkedPrPhrase, projectPrRefs } from '../../src/shared/pull-request-links'
import { projectReposFrom } from '../../src/shared/project-repos'
import { rollupChecks, type PrSummary, type RepoRef } from '../../src/shared/pull-requests'
import { PullRequestAutoLinker, type AutoLinkDeps } from '../../src/main/pull-requests/auto-link'
import type { RuntimeEvent } from '../../src/shared/provider-events'

const SB: RepoRef = { host: 'github', owner: 'tejasnafde', name: 'switchboard' }
const BOT: RepoRef = { host: 'bitbucket', owner: 'geoiq', name: 'ssg-bot-v2' }
const own = (repo: RepoRef | null) => projectReposFrom(repo, [])

describe('findPullRequestUrls', () => {
  it('reads GitHub and Bitbucket PR URLs, deduplicated, owner and repo lower case', () => {
    const text = [
      'Opened https://github.com/TejasNafde/Switchboard/pull/612 for review.',
      'See https://bitbucket.org/geoiq/ssg-bot-v2/pull-requests/88/diff and',
      '(https://www.github.com/tejasnafde/switchboard/pull/612/files#r1).',
    ].join('\n')
    expect(findPullRequestUrls(text)).toEqual([
      { host: 'github', owner: 'tejasnafde', name: 'switchboard', number: 612 },
      { host: 'bitbucket', owner: 'geoiq', name: 'ssg-bot-v2', number: 88 },
    ])
  })

  it('ignores the wrong path for a host, issues, and a number that runs into letters', () => {
    expect(findPullRequestUrls([
      'https://github.com/o/r/pull-requests/1',
      'https://bitbucket.org/o/r/pull/2',
      'https://github.com/o/r/issues/3',
      'https://github.com/o/r/pull/4abc',
      'https://github.com/o/r/pull/0',
      'https://gitlab.com/o/r/pull/5',
    ].join(' '))).toEqual([])
  })
})

describe('linking rules', () => {
  it('links only PRs of the repository the chat project points at', () => {
    const text = 'https://github.com/tejasnafde/switchboard/pull/1 and https://github.com/other/switchboard/pull/2 and https://bitbucket.org/geoiq/ssg-bot-v2/pull-requests/3'
    expect(autoLinkRefs(text, own(SB))).toEqual([{ ...SB, number: 1 }])
    expect(autoLinkRefs(text, own(BOT))).toEqual([{ ...BOT, number: 3 }])
    expect(autoLinkRefs(text, null)).toEqual([])
    expect(autoLinkRefs(text, own(null))).toEqual([])
    expect(canLinkToProject({ ...SB, owner: 'TEJASNAFDE', number: 9 }, own(SB))).toBe(true)
  })

  it('links PRs of every child repository of a parent folder, and of no other', () => {
    const CORE: RepoRef = { host: 'bitbucket', owner: 'geoiq', name: 'geoiq-ssg-core-v1' }
    const parent = projectReposFrom(null, [
      { path: '/ssg/core', relPath: 'core', repo: CORE },
      { path: '/ssg/bot', relPath: 'bot', repo: BOT },
    ])
    expect(canLinkToProject({ ...CORE, number: 4 }, parent)).toBe(true)
    expect(canLinkToProject({ ...BOT, name: 'SSG-BOT-V2', number: 4 }, parent)).toBe(true)
    expect(canLinkToProject({ ...SB, number: 4 }, parent)).toBe(false)
    const text = 'https://bitbucket.org/geoiq/geoiq-ssg-core-v1/pull-requests/7 https://bitbucket.org/geoiq/ssg-bot-v2/pull-requests/8 https://github.com/tejasnafde/switchboard/pull/9'
    expect(autoLinkRefs(text, parent)).toEqual([{ ...CORE, number: 7 }, { ...BOT, number: 8 }])
    // A bare bbpr number belongs to the project's own repository only.
    expect(projectPrRefs('', [605], parent)).toEqual([])
  })

  it('validates a PR reference from a client', () => {
    expect(isPrRef({ ...SB, number: 1 })).toBe(true)
    expect(isPrRef({ ...SB, number: 0 })).toBe(false)
    expect(isPrRef({ ...SB, owner: '../x', number: 1 })).toBe(false)
    expect(isPrRef({ host: 'gitlab', owner: 'a', name: 'b', number: 1 })).toBe(false)
  })
})

describe('linkedPrPhrase', () => {
  const pr = (over: Partial<PrSummary>): PrSummary => ({
    ref: { ...SB, number: 612 }, title: 't', url: '', author: { login: 'a', displayName: 'a', avatarUrl: null },
    state: 'open', draft: false, sourceBranch: 'f', targetBranch: 'main', createdAt: 0, updatedAt: 0, mergedAt: null,
    additions: null, deletions: null, changedFiles: null, unresolvedConversations: 0, checks: rollupChecks([]),
    reviewers: [], approvals: { given: 0, required: null },
    viewer: { isAuthor: true, isRequestedReviewer: false, hasReviewed: false, hasCommented: false }, projectPaths: [], ...over,
  })

  it('says the build and the open conversations, like the mock', () => {
    expect(linkedPrPhrase(pr({ checks: rollupChecks([{ state: 'failure' }]), unresolvedConversations: 3 }))).toBe('build failed · 3 open conversations')
    expect(linkedPrPhrase(pr({ unresolvedConversations: 1 }))).toBe('1 open conversation')
    expect(linkedPrPhrase(pr({ state: 'merged', unresolvedConversations: 2 }))).toBe('merged')
    expect(linkedPrPhrase(pr({}))).toBe('')
  })
})

describe('PullRequestAutoLinker', () => {
  function setup(projectRepo: RepoRef | null = SB) {
    const linked: string[] = []
    const notified: string[] = []
    const deps: AutoLinkDeps = {
      conversationFor: (threadId) => (threadId === 'missing' ? null : { id: 'agent_1', projectPath: '/p', cwd: '/p' }),
      projectRepos: async () => own(projectRepo),
      repoForProject: async (path) => (path.startsWith('/other') ? { host: 'bitbucket' as const, owner: 'geoiq', name: 'retailiq' } : projectRepo),
      link: (id, ref) => {
        const k = `${id}#${ref.number}`
        if (linked.includes(k)) return false
        linked.push(k)
        return true
      },
      notify: (id) => notified.push(id),
    }
    return { linker: new PullRequestAutoLinker(deps), linked, notified }
  }
  const content = (text: string, append = true, messageId = 'm1'): RuntimeEvent =>
    ({ type: 'content', threadId: 'uuid-abc', messageId, text, append, streamKind: 'assistant' }) as RuntimeEvent
  const turnDone = { type: 'turn.completed', threadId: 'uuid-abc' } as RuntimeEvent

  it('joins streamed deltas before matching, so a URL split across chunks links the whole number', async () => {
    const { linker, linked, notified } = setup()
    await linker.onEvent(content('Opened https://github.com/tejasnafde/switchboard/pull/6'))
    await linker.onEvent(content('12 for review.'))
    expect(linked).toEqual([])
    await linker.onEvent(turnDone)
    expect(linked).toEqual(['agent_1#612'])
    expect(notified).toEqual(['agent_1'])
  })

  it('links from tool output at once, and not twice', async () => {
    const { linker, linked, notified } = setup()
    const tool = { type: 'tool.completed', threadId: 't', toolId: 'x', output: 'https://github.com/tejasnafde/switchboard/pull/7' } as RuntimeEvent
    await linker.onEvent(tool)
    await linker.onEvent(tool)
    expect(linked).toEqual(['agent_1#7'])
    expect(notified).toEqual(['agent_1'])
  })

  it('never links a PR of another project, and ignores reasoning text', async () => {
    const { linker, linked, notified } = setup(BOT)
    await linker.onEvent(content('https://github.com/tejasnafde/switchboard/pull/8'))
    await linker.onEvent({ type: 'content', threadId: 'uuid-abc', messageId: 'r', text: 'https://bitbucket.org/geoiq/ssg-bot-v2/pull-requests/9', append: true, streamKind: 'reasoning' } as RuntimeEvent)
    await linker.onEvent(turnDone)
    expect(linked).toEqual([])
    expect(notified).toEqual([])
  })

  it('links a PR opened with gh pr create from its shell output', async () => {
    const { linker, linked } = setup()
    await linker.onEvent({ type: 'tool.started', threadId: 't', toolId: 'x', toolName: 'Bash', input: { command: 'gh pr create --fill' } } as RuntimeEvent)
    expect(linked).toEqual([])
    await linker.onEvent({ type: 'tool.completed', threadId: 't', toolId: 'x', output: 'Creating pull request for feat/x into main\n\nhttps://github.com/tejasnafde/switchboard/pull/190\n' } as RuntimeEvent)
    expect(linked).toEqual(['agent_1#190'])
  })

  it('links a PR URL in a tool input, Claude object or Codex command array', async () => {
    const { linker, linked, notified } = setup()
    await linker.onEvent({ type: 'tool.started', threadId: 't', toolId: 'a', toolName: 'Bash', input: { command: 'gh pr view https://github.com/tejasnafde/switchboard/pull/31 --json state' } } as RuntimeEvent)
    await linker.onEvent({ type: 'tool.started', threadId: 't', toolId: 'b', toolName: 'shell', input: { command: ['bash', '-lc', 'gh pr checks https://github.com/tejasnafde/switchboard/pull/32'] } } as RuntimeEvent)
    await linker.onEvent({ type: 'tool.started', threadId: 't', toolId: 'c', toolName: 'Bash', input: { command: 'gh pr view https://github.com/someone/else/pull/33' } } as RuntimeEvent)
    expect(linked).toEqual(['agent_1#31', 'agent_1#32'])
    expect(notified).toEqual(['agent_1', 'agent_1'])
  })

  it('links a bare bbpr number in a tool input to a Bitbucket project, never to a GitHub one or from output', async () => {
    const bb = setup(BOT)
    await bb.linker.onEvent({ type: 'tool.started', threadId: 't', toolId: 'a', toolName: 'Bash', input: { command: 'cd /repo && bbpr 605 diff' } } as RuntimeEvent)
    await bb.linker.onEvent({ type: 'tool.completed', threadId: 't', toolId: 'a', output: 'bbpr 606' } as RuntimeEvent)
    expect(bb.linked).toEqual(['agent_1#605'])
    const gh = setup(SB)
    await gh.linker.onEvent({ type: 'tool.started', threadId: 't', toolId: 'a', toolName: 'Bash', input: { command: 'bbpr 605' } } as RuntimeEvent)
    expect(gh.linked).toEqual([])
  })

  it('never links a bare bbpr number whose command runs in another repository, or behind a cd it cannot resolve', async () => {
    const { linker, linked } = setup(BOT)
    const run = (command: string) => linker.onEvent({ type: 'tool.started', threadId: 't', toolId: 'a', toolName: 'Bash', input: { command } } as RuntimeEvent)
    await run('cd /other/repo && bbpr 605 diff')
    await run('cd $REPO && bbpr 606')
    await run('cd - && bbpr 607')
    expect(linked).toEqual([])
    await run('cd /p/src && bbpr 608 diff')
    await run('cd ../p && bbpr 609')
    expect(linked).toEqual(['agent_1#608', 'agent_1#609'])
  })

  it('keeps the tombstone rule: a link the store refuses is not reported', async () => {
    const notified: string[] = []
    const linker = new PullRequestAutoLinker({
      conversationFor: () => ({ id: 'agent_1', projectPath: '/p', cwd: '/p' }),
      projectRepos: async () => own(BOT),
      repoForProject: async () => BOT,
      link: () => false,
      notify: (id) => notified.push(id),
    })
    await linker.onEvent({ type: 'tool.started', threadId: 't', toolId: 'a', toolName: 'Bash', input: { command: 'bbpr 605' } } as RuntimeEvent)
    expect(notified).toEqual([])
  })

  it('does nothing for a thread with no conversation row', async () => {
    const { linker, linked } = setup()
    await linker.onEvent({ type: 'tool.completed', threadId: 'missing', toolId: 'x', output: 'https://github.com/tejasnafde/switchboard/pull/7' } as RuntimeEvent)
    expect(linked).toEqual([])
  })
})
