/**
 * `create_pull_request` on the Switchboard MCP server, against a fake Reviews
 * service and a fake checkout: the defaults (current branch, the repository's
 * default branch), an open PR for the branch linked instead of a second one,
 * an unpushed branch or another repository refused, plan mode refused without
 * a card, the card's edits are what is opened (with the marker line), the
 * result is linked to the chat's ROOT conversation, and an uncertain host
 * answer tells the agent not to try again.
 */
import { describe, expect, it, vi } from 'vitest'
import { AgentApprovalBroker, type AgentApprovalOutcome } from '../../src/main/mcp/agent-approvals'
import { AgentWriteBudget } from '../../src/main/mcp/agent-write-budget'
import { buildPrTools, type AgentPullRequestAccess, type RemoteBranchCheck } from '../../src/main/mcp/pr-tools'
import type { CreatedPr } from '../../src/shared/agent-pr-create'
import type { PrError, PrRef, PrResult, RepoRef } from '../../src/shared/pull-requests'
import type { RuntimeEvent, RuntimeMode } from '../../src/shared/provider-events'

const APP: RepoRef = { host: 'github', owner: 'acme', name: 'app' }
const BOT: RepoRef = { host: 'bitbucket', owner: 'geoiq', name: 'ssg-bot-v2' }

interface Options {
  mode?: RuntimeMode
  repo?: RepoRef | null
  branch?: string | null
  defaultBranch?: PrResult<string>
  pushed?: RemoteBranchCheck
  open?: CreatedPr | null
  /** What the create call answers; the default opens #42. */
  create?: (input: unknown) => PrResult<CreatedPr & { existing: boolean }>
  answer?: (card: Extract<RuntimeEvent, { type: 'request.opened' }>) => AgentApprovalOutcome | null
  budget?: AgentWriteBudget
  cwd?: string | null
}

function setup(opts: Options = {}) {
  const events: RuntimeEvent[] = []
  const links: Array<{ chatId: string; ref: PrRef; created: boolean }> = []
  const creates: unknown[] = []
  let open = opts.open ?? null
  const repo = opts.repo === undefined ? APP : opts.repo
  const url = (n: number) => `https://github.com/acme/app/pull/${n}`
  const access = {
    linkedPrs: vi.fn(() => []),
    chatProject: vi.fn((chatId: string) => (chatId === 'root-1' ? '/p' : null)),
    repoFor: vi.fn(async () => repo),
    currentBranch: vi.fn(async () => (opts.branch === undefined ? 'feat/x' : opts.branch)),
    remoteHasBranch: vi.fn(async (): Promise<RemoteBranchCheck> => opts.pushed ?? { ok: true, found: true, remote: 'origin' }),
    defaultBranch: vi.fn(async () => opts.defaultBranch ?? { ok: true as const, data: 'main' }),
    openPullRequestFor: vi.fn(async () => ({ ok: true as const, data: open })),
    createPullRequest: vi.fn(async (_repo: RepoRef, input: unknown) => {
      creates.push(input)
      return opts.create?.(input) ?? { ok: true as const, data: { number: 42, url: url(42), existing: false } }
    }),
    linkToChat: vi.fn((chatId: string, ref: PrRef, created: boolean) => { links.push({ chatId, ref, created }); return true }),
  } as unknown as AgentPullRequestAccess
  const approvals = new AgentApprovalBroker({
    publish: (e) => {
      events.push(e)
      if (e.type !== 'request.opened') return
      const outcome = opts.answer?.(e)
      if (!outcome) return
      queueMicrotask(() => approvals.respond('t1', e.requestId, outcome.decision, outcome.decision === 'approve' ? outcome.response : {}, true))
    },
  })
  let mode: RuntimeMode = opts.mode ?? 'sandbox'
  const tools = buildPrTools({
    threadId: 't1',
    chatId: 'root-1',
    agentLabel: 'Codex',
    cwd: () => (opts.cwd === undefined ? '/p/.switchboard/worktrees/x' : opts.cwd),
    runtimeMode: () => mode,
    publish: (e) => events.push(e),
    approvals,
    budget: opts.budget ?? new AgentWriteBudget(),
    pullRequests: access,
  })
  const tool = tools.find((t) => t.name === 'create_pull_request')!
  const call = (args: Record<string, unknown>, signal = new AbortController().signal) => tool.call(args, { signal })
  return {
    tool, call, events, access, links, creates,
    setMode: (m: RuntimeMode) => { mode = m },
    setOpen: (pr: CreatedPr | null) => { open = pr },
  }
}

const approve = (response = {}) => () => ({ decision: 'approve' as const, response })
const opened = (events: RuntimeEvent[]) => events.filter((e) => e.type === 'request.opened') as Array<Extract<RuntimeEvent, { type: 'request.opened' }>>
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text

describe('create_pull_request: what the agent is told', () => {
  it('says to use it instead of a CLI when asked to raise a PR, and needs only a title', () => {
    const { tool } = setup()
    expect(tool.description).toMatch(/raise, open or create a pull request/)
    expect(tool.description).toMatch(/instead of gh pr create, bbpr/)
    expect(tool.description).toMatch(/push the branch first/i)
    expect(tool.inputSchema.required).toEqual(['title'])
    expect(Object.keys(tool.inputSchema.properties as object).sort()).toEqual(['description', 'draft', 'repository', 'sourceBranch', 'targetBranch', 'title'])
  })
})

describe('create_pull_request: defaults and the card', () => {
  it('defaults to the checkout branch and the default branch, and the card shows both, editable', async () => {
    const s = setup({ answer: approve() })
    const result = await s.call({ title: 'Jittered backoff', description: 'Adds jitter.\n\nTested with the unit suite.' })
    expect(result.isError).toBeFalsy()
    expect(s.access.currentBranch).toHaveBeenCalledWith('/p/.switchboard/worktrees/x')
    expect(s.access.remoteHasBranch).toHaveBeenCalledWith('/p/.switchboard/worktrees/x', APP, 'feat/x')
    const [card] = opened(s.events)
    expect(card.toolName).toBe('mcp__switchboard__create_pull_request')
    expect(card.hostWrite).toMatchObject({
      action: 'create',
      host: 'github',
      prLabel: 'acme/app',
      create: { repoLabel: 'acme/app', sourceBranch: 'feat/x', targetBranch: 'main', title: 'Jittered backoff', draft: false },
    })
    expect(card.detail).toContain('Open a pull request on acme/app: feat/x -> main')
    expect(s.creates).toEqual([{
      title: 'Jittered backoff',
      description: 'Adds jitter.\n\nTested with the unit suite.\n\nvia Switchboard',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      draft: false,
    }])
    expect(text(result)).toContain('Opened acme/app #42: https://github.com/acme/app/pull/42')
    expect(text(result)).toContain('linked to this chat and shows in Reviews')
  })

  it('links the new PR to the ROOT conversation and asks Reviews to refresh', async () => {
    const s = setup({ answer: approve() })
    await s.call({ title: 'T' })
    expect(s.links).toEqual([{ chatId: 'root-1', ref: { ...APP, number: 42 }, created: true }])
  })

  it('says the link failed, and still gives the URL, when the link cannot be stored', async () => {
    const s = setup({ answer: approve() })
    vi.mocked(s.access.linkToChat).mockReturnValue(false)
    const result = await s.call({ title: 'T' })
    expect(text(result)).toContain('Opened acme/app #42: https://github.com/acme/app/pull/42')
    expect(text(result)).toContain('Linking it to this chat failed')
    expect(text(result)).not.toContain('shows in Reviews')
    expect(text(result)).toContain('cannot act on it yet')
    expect(text(result)).not.toContain('can act on it now')
  })

  it('uses the project path when the session has no cwd, and explicit branches as given', async () => {
    const s = setup({ cwd: null, answer: approve() })
    await s.call({ title: 'T', sourceBranch: 'refs/heads/fix/a', targetBranch: 'release/2' })
    expect(s.access.remoteHasBranch).toHaveBeenCalledWith('/p', APP, 'fix/a')
    expect(s.access.currentBranch).not.toHaveBeenCalled()
    expect(s.access.defaultBranch).not.toHaveBeenCalled()
    expect(s.creates[0]).toMatchObject({ sourceBranch: 'fix/a', targetBranch: 'release/2' })
  })

  it('opens what the user left in the card, not the agent draft, and says so', async () => {
    const s = setup({ answer: approve({ title: '  Backoff with jitter ', description: 'Rewritten by me.' }) })
    const result = await s.call({ title: 'Agent title', description: 'Agent body' })
    expect(s.creates[0]).toMatchObject({ title: 'Backoff with jitter', description: 'Rewritten by me.\n\nvia Switchboard' })
    expect(text(result)).toContain('The user edited the title to "Backoff with jitter" and the description first.')
  })

  it('refuses an edited title the user emptied, and opens nothing', async () => {
    const s = setup({ answer: approve({ title: '   ' }) })
    const result = await s.call({ title: 'T' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('The edited title was refused')
    expect(s.creates).toEqual([])
  })

  it('opens a draft on GitHub, and refuses one on Bitbucket before a card', async () => {
    const gh = setup({ answer: approve() })
    await gh.call({ title: 'T', draft: true })
    expect(opened(gh.events)[0].hostWrite?.create?.draft).toBe(true)
    expect(gh.creates[0]).toMatchObject({ draft: true })

    const bb = setup({ repo: BOT, answer: approve() })
    const result = await bb.call({ title: 'T', draft: true })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/cannot open a draft there/)
    expect(opened(bb.events)).toEqual([])
  })
})

describe('create_pull_request: refused before a card', () => {
  it('links an open PR for the branch instead of opening a second, without a card or a budget charge', async () => {
    const budget = new AgentWriteBudget(1)
    const s = setup({ open: { number: 7, url: 'https://github.com/acme/app/pull/7' }, budget })
    const result = await s.call({ title: 'T' })
    expect(result.isError).toBeFalsy()
    expect(text(result)).toContain('already open for feat/x: acme/app #7')
    expect(s.links).toEqual([{ chatId: 'root-1', ref: { ...APP, number: 7 }, created: false }])
    expect(opened(s.events)).toEqual([])
    expect(s.creates).toEqual([])
    expect(budget.take('root-1').ok).toBe(true)
  })

  it('refuses a branch that is not pushed, naming the push to run', async () => {
    const s = setup({ pushed: { ok: true, found: false, remote: 'origin' } })
    const result = await s.call({ title: 'T' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('feat/x is not on origin (acme/app). Push it first (git push -u origin feat/x)')
    expect(opened(s.events)).toEqual([])
    expect(s.access.openPullRequestFor).not.toHaveBeenCalled()
  })

  it('refuses when git could not ask the remote', async () => {
    const s = setup({ pushed: { ok: false, message: 'git could not read the branches of origin: Permission denied (publickey).' } })
    const result = await s.call({ title: 'T' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Permission denied (publickey)')
  })

  it('refuses another repository, whatever form names it, and takes its own', async () => {
    for (const repository of ['someone/app', 'https://github.com/acme/lib', 'git@bitbucket.org:acme/app.git']) {
      const s = setup()
      const result = await s.call({ title: 'T', repository })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('can only open pull requests on acme/app')
      expect(opened(s.events)).toEqual([])
    }
    const own = setup({ answer: approve() })
    expect((await own.call({ title: 'T', repository: 'https://github.com/ACME/app' })).isError).toBeFalsy()
  })

  it('refuses a project whose remotes are not on GitHub or Bitbucket', async () => {
    const s = setup({ repo: null })
    const result = await s.call({ title: 'T' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('point at neither GitHub nor Bitbucket')
  })

  it('refuses the same source and target, and a detached HEAD', async () => {
    const same = await setup({ branch: 'main' }).call({ title: 'T' })
    expect(text(same)).toContain('both main')
    const detached = await setup({ branch: null }).call({ title: 'T' })
    expect(text(detached)).toContain('Pass "sourceBranch"')
  })

  it('refuses bad arguments with the reason', async () => {
    const s = setup()
    expect(text(await s.call({ title: '' }))).toContain('The title is empty.')
    expect(text(await s.call({ title: 'T', sourceBranch: '--upload-pack=evil' }))).toContain('is not a branch name')
    expect(text(await s.call({ title: 'T', targetBranch: 'a..b' }))).toContain('is not a branch name')
    expect(text(await s.call({ title: 'x'.repeat(300) }))).toContain('the limit is 255')
    expect(opened(s.events)).toEqual([])
  })

  it('says why when the default branch cannot be read', async () => {
    const error: PrError = { kind: 'token_rejected', host: 'github', message: 'gh is signed out or its token was rejected.' }
    const result = await setup({ defaultBranch: { ok: false, error } }).call({ title: 'T' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('gh is signed out')
  })
})

describe('create_pull_request: modes and the budget', () => {
  it('plan mode refuses without a card, with a denial pill', async () => {
    const s = setup({ mode: 'plan' })
    const result = await s.call({ title: 'T' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/^Plan mode/)
    expect(opened(s.events)).toEqual([])
    expect(s.events.some((e) => e.type === 'tool.denied' && e.toolName === 'mcp__switchboard__create_pull_request')).toBe(true)
    expect(s.access.remoteHasBranch).not.toHaveBeenCalled()
  })

  it('full access opens the pull request without a card, and still counts it', async () => {
    const budget = new AgentWriteBudget(1)
    const s = setup({ mode: 'full-access', budget })
    const result = await s.call({ title: 'T', description: 'Body' })
    expect(opened(s.events)).toHaveLength(0)
    expect(s.creates).toEqual([expect.objectContaining({ title: 'T', description: 'Body\n\nvia Switchboard' })])
    expect(text(result)).toContain('Opened acme/app #42')
    expect((await s.call({ title: 'T2' })).isError).toBe(true)
  })

  it('creates nothing when full access ends while the tool checks the repository', async () => {
    const s = setup({ mode: 'full-access' })
    vi.mocked(s.access.repoFor).mockImplementation(async () => {
      if (vi.mocked(s.access.repoFor).mock.calls.length > 1) s.setMode('sandbox')
      return APP
    })
    const result = await s.call({ title: 'T' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('left full access')
    expect(s.creates).toEqual([])
  })

  it('every other mode except plan shows the card', async () => {
    for (const mode of ['sandbox', 'accept-edits', 'auto'] as const) {
      const s = setup({ mode, answer: approve() })
      await s.call({ title: 'T' })
      expect(opened(s.events)).toHaveLength(1)
    }
  })

  it('counts against the write budget', async () => {
    const budget = new AgentWriteBudget(1)
    const s = setup({ answer: approve(), budget })
    expect((await s.call({ title: 'T' })).isError).toBeFalsy()
    const second = await s.call({ title: 'T2' })
    expect(second.isError).toBe(true)
    expect(text(second)).toContain('which is the limit')
    expect(s.creates).toHaveLength(1)
  })

  it('a denied card opens nothing', async () => {
    const s = setup({ answer: () => ({ decision: 'deny', reason: 'user' }) })
    const result = await s.call({ title: 'T' })
    expect(result.isError).toBe(true)
    expect(s.creates).toEqual([])
    expect(s.links).toEqual([])
  })

  it('opens nothing when plan mode was switched on while the card was open', async () => {
    let s: ReturnType<typeof setup>
    s = setup({ answer: () => { s.setMode('plan'); return { decision: 'approve', response: {} } } })
    const result = await s.call({ title: 'T' })
    expect(result.isError).toBe(true)
    expect(s.creates).toEqual([])
  })

  it('opens nothing when the project stopped pointing at the repository while the card was open', async () => {
    let s: ReturnType<typeof setup>
    s = setup({
      answer: () => {
        vi.mocked(s.access.repoFor).mockResolvedValue({ host: 'github', owner: 'acme', name: 'other' })
        return { decision: 'approve', response: {} }
      },
    })
    const result = await s.call({ title: 'T' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no longer points at acme/app')
    expect(s.creates).toEqual([])
  })

  it('opens nothing when the agent stopped waiting', async () => {
    const controller = new AbortController()
    const s = setup({ answer: () => { controller.abort(); return null } })
    const result = await s.call({ title: 'T' }, controller.signal)
    expect(result.isError).toBe(true)
    expect(s.creates).toEqual([])
  })
})

describe('create_pull_request: the host answer', () => {
  it('passes a definite refusal on, missing scope included, and says nothing was created', async () => {
    const error: PrError = { kind: 'forbidden', host: 'bitbucket', message: 'The Bitbucket API token is missing the write:pullrequest:bitbucket scope.' }
    const s = setup({ repo: BOT, answer: approve(), create: () => ({ ok: false, error }) })
    const result = await s.call({ title: 'T' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('write:pullrequest:bitbucket')
    expect(text(result)).toContain('Nothing was created.')
    expect(s.links).toEqual([])
  })

  it('links the one that appeared while the card was open, instead of a second', async () => {
    const s = setup({ answer: approve(), create: () => ({ ok: true, data: { number: 9, url: 'https://github.com/acme/app/pull/9', existing: true } }) })
    const result = await s.call({ title: 'T' })
    expect(text(result)).toContain('opened while the card was open: acme/app #9')
    expect(s.links).toEqual([{ chatId: 'root-1', ref: { ...APP, number: 9 }, created: false }])
  })

  it('on an uncertain answer, looks for the PR, and links it if it is there', async () => {
    let s: ReturnType<typeof setup>
    s = setup({
      answer: approve(),
      create: () => {
        s.setOpen({ number: 43, url: 'https://github.com/acme/app/pull/43' })
        return { ok: false, error: { kind: 'unknown', host: 'github', message: 'gh did not answer within 30s' } }
      },
    })
    const result = await s.call({ title: 'T' })
    expect(result.isError).toBeFalsy()
    expect(text(result)).toContain('Opened acme/app #43')
    expect(text(result)).toContain('Do not open it again')
    expect(s.links).toEqual([{ chatId: 'root-1', ref: { ...APP, number: 43 }, created: true }])
  })

  it('on an uncertain answer with no PR found, tells the agent not to create again', async () => {
    const s = setup({ answer: approve(), create: () => ({ ok: false, error: { kind: 'offline', host: 'bitbucket', message: 'Could not reach bitbucket.org.' } }) })
    const result = await s.call({ title: 'T' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('may or may not have been opened')
    expect(text(result)).toContain('Do not call create_pull_request again')
  })
})
