/**
 * The pure rules behind create_pull_request: argument checks, branch names
 * no command line reads as an option, the one-repository rule, drafts, the
 * uncertain-failure rule, the card's plain-text detail and buttons, the git
 * checks in the chat's checkout (against a fake git), and the Reviews
 * refresh an opened PR asks for.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/logger', () => ({ createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))
vi.mock('../../src/main/shell-env', () => ({ childProcessEnv: () => ({}) }))

import {
  checkCreatePrArgs,
  draftProblem,
  isBranchName,
  isUncertainCreateFailure,
  parseRepoArg,
  repositoryProblem,
} from '../../src/shared/agent-pr-create'
import { hostWriteDetail, hostWriteTitle, parseHostWriteResponse, type HostWriteCard } from '../../src/shared/agent-host-writes'
import { remotesForRepo } from '../../src/shared/pull-request-remote'
import { shouldRefreshPullRequests } from '../../src/shared/pull-request-refresh'
import { pushForEvent } from '../../src/shared/push-policy'
import { createDraftProblem, hostWriteButtons, hostWriteResponse, initialCreateDraft, initialReviewDraft } from '../../src/renderer/components/chat/host-write-card'
import { currentBranch, remoteHasBranch, type GitRun } from '../../src/main/pull-requests/branch-check'
import { SWITCHBOARD_OPENCODE_TOOLS } from '../../src/main/mcp/agent-registration'
import { bbprTargets, bbprTargetsForInput, toolInputCwd } from '../../src/shared/bbpr-command'
import { bbprNumbersInRepo } from '../../src/main/pull-requests/bbpr-targets'
import type { RepoRef } from '../../src/shared/pull-requests'

const APP: RepoRef = { host: 'github', owner: 'acme', name: 'app' }

describe('arguments', () => {
  it('trims the title, keeps an empty description, and leaves the defaults to the tool', () => {
    expect(checkCreatePrArgs({ title: '  Add  jitter\n' })).toEqual({
      ok: true,
      value: { title: 'Add jitter', description: '', sourceBranch: null, targetBranch: null, draft: false, repository: null },
    })
  })

  it('refuses a description over the cap and a draft that is not a boolean', () => {
    expect(checkCreatePrArgs({ title: 'T', description: 'x'.repeat(16_001) })).toMatchObject({ ok: false })
    expect(checkCreatePrArgs({ title: 'T', draft: 'yes' })).toEqual({ ok: false, message: '"draft" is true or false.' })
  })

  it('takes git branch names and refuses anything git or a command line would misread', () => {
    for (const ok of ['main', 'feat/x', 'fix/redis-timeout_2', 'release/1.2', 'kanban/card-abc123']) expect(isBranchName(ok)).toBe(true)
    for (const bad of ['', '-x', '--upload-pack=x', 'a..b', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', '/a', 'a/', 'a.lock', 'a/.hidden', 'a//b', 'a@{1}', '@', 'a.', 'x'.repeat(256), 'a\u0000b']) {
      expect(isBranchName(bad)).toBe(false)
    }
    expect(checkCreatePrArgs({ title: 'T', sourceBranch: 'refs/heads/feat/x' })).toMatchObject({ ok: true, value: { sourceBranch: 'feat/x' } })
  })
})

describe('the repository rule and drafts', () => {
  it('reads owner/name, a web URL and a remote URL', () => {
    expect(parseRepoArg('acme/app', 'github')).toEqual(APP)
    expect(parseRepoArg('https://github.com/acme/app/pull/3', 'bitbucket')).toEqual(APP)
    expect(parseRepoArg('git@github.com:acme/app.git', 'github')).toEqual(APP)
  })

  it("refuses any repository but the chat's own, case aside", () => {
    expect(repositoryProblem(null, APP)).toBeNull()
    expect(repositoryProblem('ACME/App', APP)).toBeNull()
    expect(repositoryProblem('acme/lib', APP)).toContain('can only open pull requests on acme/app')
    // The same owner and name on the other host is another repository.
    expect(repositoryProblem('https://bitbucket.org/acme/app', APP)).not.toBeNull()
  })

  it('refuses a draft only on Bitbucket', () => {
    expect(draftProblem('github', true)).toBeNull()
    expect(draftProblem('bitbucket', false)).toBeNull()
    expect(draftProblem('bitbucket', true)).toContain('cannot open a draft there')
  })

  it('treats offline and unknown host failures as uncertain, and a refusal as certain', () => {
    expect(isUncertainCreateFailure({ kind: 'offline', host: 'github', message: '' })).toBe(true)
    expect(isUncertainCreateFailure({ kind: 'unknown', host: 'github', message: '' })).toBe(true)
    for (const kind of ['forbidden', 'invalid', 'token_rejected', 'rate_limited', 'conflict'] as const) {
      expect(isUncertainCreateFailure({ kind, host: 'github', message: '' })).toBe(false)
    }
  })

  it('finds the remote for the repository, not the first one', () => {
    const remotes = [
      'fork\tgit@github.com:me/app.git (fetch)',
      'fork\tgit@github.com:me/app.git (push)',
      'origin\thttps://github.com/ACME/app.git (fetch)',
      'origin\thttps://github.com/ACME/app.git (push)',
    ].join('\n')
    expect(remotesForRepo(remotes, APP)).toEqual(['origin'])
    expect(remotesForRepo(remotes, { ...APP, name: 'lib' })).toEqual([])
  })
})

const card: HostWriteCard = {
  action: 'create',
  agentLabel: 'Claude Code',
  host: 'github',
  prLabel: 'acme/app',
  url: null,
  location: null,
  quote: null,
  create: { repoLabel: 'acme/app', sourceBranch: 'feat/x', targetBranch: 'main', title: 'Add jitter', description: 'Adds jitter.', draft: false },
  maxChars: 16_000,
}

describe('the card', () => {
  it('says what it opens, in plain text for a client that does not render it', () => {
    expect(hostWriteTitle(card)).toBe('Open a pull request')
    expect(hostWriteTitle({ ...card, create: { ...card.create!, draft: true } })).toBe('Open a draft pull request')
    expect(hostWriteDetail(card)).toBe([
      'Open a pull request on acme/app: feat/x -> main', '', 'Add jitter', '', 'Adds jitter.',
    ].join('\n'))
    const push = pushForEvent({ type: 'request.opened', threadId: 't', requestId: 'sbmcp_1', requestType: 'tool', toolName: 'x', detail: '', hostWrite: card }, { title: 'Chat' })
    expect(push?.body).toBe('Needs approval: Open a pull request on acme/app')
  })

  it('offers Deny and Open pull request, and sends back the title and description as edited', () => {
    const buttons = hostWriteButtons(card)
    expect(buttons.map((b) => [b.id, b.label, b.primary])).toEqual([['deny', 'Deny', false], ['create', 'Open pull request', true]])
    expect(hostWriteButtons({ ...card, create: { ...card.create!, draft: true } })[1].label).toBe('Open draft')
    const draft = initialCreateDraft(card)
    expect(draft).toEqual({ title: 'Add jitter', description: 'Adds jitter.' })
    expect(hostWriteResponse(card, buttons[1], '', initialReviewDraft(undefined), { title: 'Mine', description: 'Body' })).toEqual({ title: 'Mine', description: 'Body' })
    expect(parseHostWriteResponse({ title: 'Mine', description: 'Body', extra: 1 })).toEqual({ title: 'Mine', description: 'Body' })
  })

  it('will not open an emptied title', () => {
    expect(createDraftProblem({ title: ' ', description: '' })).toBe('The title is empty.')
    expect(createDraftProblem({ title: 'T', description: '' })).toBeNull()
  })
})

describe('git in the checkout', () => {
  const git = (answers: Record<string, { code: number; stdout: string; stderr?: string }>): { run: GitRun; calls: string[][] } => {
    const calls: string[][] = []
    const run: GitRun = async (cwd, args) => {
      calls.push([cwd, ...args])
      const a = answers[args[0]] ?? { code: 1, stdout: '' }
      return { code: a.code, stdout: a.stdout, stderr: a.stderr ?? '' }
    }
    return { run, calls }
  }

  it('reads the current branch, and none for a detached HEAD', async () => {
    expect(await currentBranch('/w', git({ 'symbolic-ref': { code: 0, stdout: 'feat/x\n' } }).run)).toBe('feat/x')
    expect(await currentBranch('/w', git({ 'symbolic-ref': { code: 1, stdout: '' } }).run)).toBeNull()
  })

  it('asks the remote of the repository for exactly that branch', async () => {
    const remotes = { code: 0, stdout: 'origin\tgit@github.com:acme/app.git (fetch)\n' }
    const pushed = git({ remote: remotes, 'ls-remote': { code: 0, stdout: 'abc123\trefs/heads/feat/x\n' } })
    expect(await remoteHasBranch('/w', APP, 'feat/x', pushed.run)).toEqual({ ok: true, found: true, remote: 'origin' })
    expect(pushed.calls[1]).toEqual(['/w', 'ls-remote', '--heads', 'origin', 'refs/heads/feat/x'])
    // A longer branch that merely ends the same way is not the branch.
    const other = git({ remote: remotes, 'ls-remote': { code: 0, stdout: 'abc123\trefs/heads/old/feat/x\n' } })
    expect(await remoteHasBranch('/w', APP, 'feat/x', other.run)).toEqual({ ok: true, found: false, remote: 'origin' })
  })

  it('says why when there is no remote for the repository, or the remote cannot be read', async () => {
    const none = git({ remote: { code: 0, stdout: 'origin\tgit@github.com:someone/else.git (fetch)\n' } })
    expect(await remoteHasBranch('/w', APP, 'feat/x', none.run)).toEqual({ ok: false, message: 'This checkout has no git remote for acme/app.' })
    const denied = git({ remote: { code: 0, stdout: 'origin\tgit@github.com:acme/app.git (fetch)\n' }, 'ls-remote': { code: 128, stdout: '', stderr: 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.' } })
    const result = await remoteHasBranch('/w', APP, 'feat/x', denied.run)
    expect(result).toEqual({ ok: false, message: 'git could not read the branches of origin: git@github.com: Permission denied (publickey).' })
  })
})

describe('registration and Reviews', () => {
  it('lets OpenCode call create_pull_request without a second prompt', () => {
    expect(SWITCHBOARD_OPENCODE_TOOLS).toContain('switchboard_create_pull_request')
  })

  it('refreshes a stale list whatever the reason, and a fresh one only on its cadence', () => {
    const fresh = { lastFetchAt: 1_000, inFlight: false, visible: true }
    expect(shouldRefreshPullRequests(fresh, 'open', 2_000)).toBe(false)
    expect(shouldRefreshPullRequests({ ...fresh, stale: true }, 'open', 2_000)).toBe(true)
    expect(shouldRefreshPullRequests({ ...fresh, stale: true, visible: false }, 'open', 2_000)).toBe(false)
  })
})

describe('where a bare bbpr runs', () => {
  it('is the cwd with no cd, the resolved directory after cds, and unknown when only a shell could tell', () => {
    expect(bbprTargets('bbpr 605 diff', '/p')).toEqual([{ number: 605, runsIn: 'cwd' }])
    expect(bbprTargets('cd /other/repo && bbpr 605', '/p')).toEqual([{ number: 605, runsIn: 'dir', dir: '/other/repo' }])
    expect(bbprTargets('cd src && cd ../lib/ && bbpr 1; cd "/a b" && bbpr 2', '/p')).toEqual([
      { number: 1, runsIn: 'dir', dir: '/p/lib' },
      { number: 2, runsIn: 'dir', dir: '/a b' },
    ])
    for (const cd of ['cd ~/x', 'cd $DIR', 'cd -', 'cd', 'cd a b', 'pushd `pwd`', 'cd x && popd']) {
      expect(bbprTargets(`${cd} && bbpr 3`, '/p')).toEqual([{ number: 3, runsIn: 'unknown' }])
    }
    expect(bbprTargets('cd rel && bbpr 4', null)).toEqual([{ number: 4, runsIn: 'unknown' }])
    // A cd after the bbpr call does not move it.
    expect(bbprTargets('bbpr 5 && cd /else', '/p')).toEqual([{ number: 5, runsIn: 'cwd' }])
  })

  it('lets an absolute cd reset a directory it could not follow, and keeps a relative one unknown', () => {
    expect(bbprTargets('cd ~ && cd /repo && bbpr 6', '/p')).toEqual([{ number: 6, runsIn: 'dir', dir: '/repo' }])
    expect(bbprTargets('cd ~ && cd rel && bbpr 7', '/p')).toEqual([{ number: 7, runsIn: 'unknown' }])
  })

  it("reads the working directory a Codex tool input records, only when absolute", () => {
    expect(toolInputCwd(JSON.stringify({ command: ['bash', '-lc', 'bbpr 605'], cwd: '/other/repo' }))).toBe('/other/repo')
    expect(toolInputCwd(JSON.stringify({ command: 'bbpr 605', workdir: '/w' }))).toBe('/w')
    expect(toolInputCwd(JSON.stringify({ command: 'bbpr 605', cwd: 'rel' }))).toBeNull()
    expect(toolInputCwd('bbpr 605')).toBeNull()
    // A recorded directory is checked like a cd, never taken for the chat's own.
    expect(bbprTargetsForInput('bbpr 605', '/p', '/other/repo')).toEqual([{ number: 605, runsIn: 'dir', dir: '/other/repo' }])
    expect(bbprTargetsForInput('cd sub && bbpr 8', '/p', '/other/repo')).toEqual([{ number: 8, runsIn: 'dir', dir: '/other/repo/sub' }])
    expect(bbprTargetsForInput('bbpr 9', '/p', null)).toEqual([{ number: 9, runsIn: 'cwd' }])
  })

  it('keeps a number only when its directory is the chat repository, asking each directory once', async () => {
    const BOT: RepoRef = { host: 'bitbucket', owner: 'geoiq', name: 'ssg-bot-v2' }
    const repoForDir = vi.fn(async (dir: string): Promise<RepoRef | null> => (dir === '/p/sub' ? BOT : dir === '/boom' ? Promise.reject(new Error('x')) : { ...BOT, name: 'retailiq' }))
    const numbers = await bbprNumbersInRepo([
      { number: 1, runsIn: 'cwd' },
      { number: 2, runsIn: 'dir', dir: '/p/sub' },
      { number: 3, runsIn: 'dir', dir: '/other' },
      { number: 4, runsIn: 'unknown' },
      { number: 5, runsIn: 'dir', dir: '/boom' },
      { number: 6, runsIn: 'dir', dir: '/p/sub' },
    ], BOT, repoForDir)
    expect(numbers).toEqual([1, 2, 6])
    expect(repoForDir).toHaveBeenCalledTimes(3)
    expect(await bbprNumbersInRepo([{ number: 1, runsIn: 'cwd' }], APP, repoForDir)).toEqual([])
  })
})
