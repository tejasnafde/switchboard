/**
 * The pull request tools of the Switchboard MCP server, against a fake
 * Reviews service: only linked PRs, plan mode refuses without a card, every
 * other mode (full access included) shows one, the text the user edited is
 * what is posted, with the marker line, and every refusal is isError output.
 */
import { describe, expect, it, vi } from 'vitest'
import { AgentApprovalBroker, type AgentApprovalOutcome } from '../../src/main/mcp/agent-approvals'
import { AgentWriteBudget } from '../../src/main/mcp/agent-write-budget'
import { buildPrTools, pickLinkedPr, type AgentPullRequestAccess } from '../../src/main/mcp/pr-tools'
import type { McpTool } from '../../src/main/mcp/mcp-session'
import type { PrCheck, PrConversation, PrDetail, PrRef } from '../../src/shared/pull-requests'
import type { RuntimeEvent, RuntimeMode } from '../../src/shared/provider-events'

const PR: PrRef = { host: 'github', owner: 'acme', name: 'app', number: 612 }
const OTHER: PrRef = { host: 'github', owner: 'acme', name: 'lib', number: 7 }

const conversation: PrConversation = {
  id: 'PRRT_1',
  path: 'sync/worker.py',
  line: 88,
  side: 'new',
  resolved: false,
  outdated: false,
  comments: [{ id: 'c1', author: { login: 'pankaj', displayName: 'Pankaj', avatarUrl: null }, body: 'Cap the jitter too.', createdAt: 0, url: 'https://github.com/acme/app/pull/612#discussion_r1' }],
}

const failedCheck: PrCheck = { id: 'chk1', name: 'integration', state: 'failure', description: null, url: null, durationMs: null, rerunId: '99' }

function detail(): PrDetail {
  return {
    ref: PR, title: 'Sync backoff', url: 'https://github.com/acme/app/pull/612',
    author: { login: 'tejas', displayName: 'Tejas', avatarUrl: null }, state: 'open', draft: false,
    sourceBranch: 'backoff', targetBranch: 'main', createdAt: 0, updatedAt: 0, mergedAt: null,
    additions: 1, deletions: 1, changedFiles: 1, unresolvedConversations: 1,
    checks: { state: 'failure', total: 1, passed: 0, failed: 1, pending: 0 },
    reviewers: [], approvals: { given: 0, required: 1 }, viewer: { isAuthor: true, isRequestedReviewer: false, hasReviewed: false },
    projectPaths: ['/p'], description: 'body', headSha: 'abc', mergeBlockers: [{ kind: 'checks_failed', label: 'Checks failed' }],
    mergeStrategies: ['merge_commit'], activity: [], checkList: [failedCheck],
  }
}

function fakeAccess(linked: PrRef[] = [PR]) {
  const calls: Array<{ op: string; ref: PrRef; input?: unknown; resolved?: boolean }> = []
  const ok = { ok: true as const, data: { refresh: [] } }
  const access: AgentPullRequestAccess = {
    linkedPrs: vi.fn(() => linked),
    detail: vi.fn(async () => ({ ok: true as const, data: detail() })),
    conversations: vi.fn(async () => ({ ok: true as const, data: [conversation] })),
    reply: vi.fn(async (ref, input) => { calls.push({ op: 'reply', ref, input }); return ok }),
    setResolved: vi.fn(async (ref, input, resolved) => { calls.push({ op: 'resolve', ref, input, resolved }); return ok }),
    rerunCheck: vi.fn(async (ref, input) => { calls.push({ op: 'rerun', ref, input }); return ok }),
  }
  return { access, calls }
}

function setup(opts: { mode?: RuntimeMode; linked?: PrRef[]; answer?: (card: Extract<RuntimeEvent, { type: 'request.opened' }>) => AgentApprovalOutcome | null; budget?: AgentWriteBudget } = {}) {
  const events: RuntimeEvent[] = []
  const { access, calls } = fakeAccess(opts.linked)
  const approvals = new AgentApprovalBroker({
    publish: (e) => {
      events.push(e)
      if (e.type !== 'request.opened') return
      const outcome = opts.answer?.(e)
      if (!outcome) return
      queueMicrotask(() => approvals.respond('t1', e.requestId, outcome.decision, outcome.decision === 'approve' ? outcome.response : {}, true))
    },
  })
  const mode: RuntimeMode = opts.mode ?? 'sandbox'
  const tools = buildPrTools({
    threadId: 't1',
    chatId: 'root-1',
    agentLabel: 'Codex',
    runtimeMode: () => mode,
    publish: (e) => events.push(e),
    approvals,
    budget: opts.budget ?? new AgentWriteBudget(),
    pullRequests: access,
  })
  const tool = (name: string): McpTool => tools.find((t) => t.name === name)!
  const call = (name: string, args: Record<string, unknown>) => tool(name).call(args, { signal: new AbortController().signal })
  return { tools, call, events, access, calls }
}

const approve = (response = {}) => () => ({ decision: 'approve' as const, response })
const deny = () => ({ decision: 'deny' as const, reason: 'user' as const })
const opened = (events: RuntimeEvent[]) => events.filter((e) => e.type === 'request.opened') as Array<Extract<RuntimeEvent, { type: 'request.opened' }>>
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text

describe('the tool list', () => {
  it('has the two reads and three writes, annotated, and nothing that approves or merges', () => {
    const { tools } = setup()
    expect(tools.map((t) => [t.name, t.annotations.readOnlyHint])).toEqual([
      ['get_pr_status', true],
      ['list_pr_conversations', true],
      ['reply_to_conversation', false],
      ['resolve_conversation', false],
      ['rerun_check', false],
    ])
    expect(tools.some((t) => /approve|merge|request_changes|review/.test(t.name))).toBe(false)
  })
})

describe('pickLinkedPr', () => {
  it('uses the only linked PR when none is named', () => {
    expect(pickLinkedPr([PR], undefined)).toEqual({ ok: true, ref: PR })
  })

  it('takes a number, "#n" or a URL, but only of a linked PR', () => {
    expect(pickLinkedPr([PR, OTHER], 612)).toEqual({ ok: true, ref: PR })
    expect(pickLinkedPr([PR, OTHER], '#7')).toEqual({ ok: true, ref: OTHER })
    expect(pickLinkedPr([PR, OTHER], 'https://github.com/ACME/app/pull/612')).toEqual({ ok: true, ref: PR })
    expect(pickLinkedPr([PR], 'https://github.com/acme/app/pull/613').ok).toBe(false)
    expect(pickLinkedPr([PR], 99).ok).toBe(false)
  })

  it('asks which one when several are linked, and explains when none is', () => {
    expect(pickLinkedPr([PR, OTHER], undefined).ok).toBe(false)
    const none = pickLinkedPr([], undefined)
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.message).toContain('Link to chat')
  })
})

describe('reads', () => {
  it('reports status of the linked PR, with the check ids rerun_check takes', async () => {
    const { call, events } = setup()
    const result = await call('get_pr_status', {})
    const body = JSON.parse(text(result))
    expect(body.pr).toBe('GitHub acme/app #612')
    expect(body.checkList).toEqual([{ id: 'chk1', name: 'integration', state: 'failure', description: null, url: null, canRerun: true }])
    expect(body.mergeBlockers).toEqual(['Checks failed'])
    expect(opened(events)).toEqual([])
  })

  it('lists open conversations with their ids', async () => {
    const { call } = setup()
    const body = JSON.parse(text(await call('list_pr_conversations', {})))
    expect(body).toEqual([{ id: 'PRRT_1', location: 'sync/worker.py:88', resolved: false, outdated: false, comments: [{ author: 'pankaj', body: 'Cap the jitter too.', at: '1970-01-01T00:00:00.000Z' }] }])
  })

  it('reads the links of the chat\'s root conversation', async () => {
    const { call, access } = setup()
    await call('get_pr_status', {})
    expect(access.linkedPrs).toHaveBeenCalledWith('root-1')
  })

  it('refuses, as tool output, a PR that is not linked', async () => {
    const { call, access } = setup()
    const result = await call('get_pr_status', { pr: 'https://github.com/acme/other/pull/1' })
    expect(result.isError).toBe(true)
    expect(access.detail).not.toHaveBeenCalled()
  })
})

describe('reply_to_conversation', () => {
  it('opens one card quoting the reviewer and posts the edited text with the marker', async () => {
    const { call, events, calls } = setup({ answer: approve({ text: 'Edited by the user.', resolve: false }) })
    const result = await call('reply_to_conversation', { conversationId: 'PRRT_1', text: 'Done in a1b2c3d.', resolve: true })

    const cards = opened(events)
    expect(cards).toHaveLength(1)
    expect(cards[0].hostWrite).toMatchObject({
      action: 'reply', agentLabel: 'Codex', prLabel: 'app #612', location: 'sync/worker.py:88',
      quote: { author: 'pankaj', body: 'Cap the jitter too.' }, replyText: 'Done in a1b2c3d.', suggestResolve: true,
    })
    expect(calls).toEqual([{ op: 'reply', ref: PR, input: { conversationId: 'PRRT_1', body: 'Edited by the user.\n\nvia Switchboard' } }])
    expect(result.isError).toBeUndefined()
    expect(text(result)).toContain('edited your reply')
  })

  it('posts and resolves on "Post and resolve"', async () => {
    const { call, calls } = setup({ answer: approve({ text: 'Done.', resolve: true }) })
    await call('reply_to_conversation', { conversationId: 'PRRT_1', text: 'Done.' })
    expect(calls.map((c) => c.op)).toEqual(['reply', 'resolve'])
    expect(calls[1]).toMatchObject({ input: { conversationId: 'PRRT_1' }, resolved: true })
  })

  it('does what the agent asked when the client sent no choice (a plain approval)', async () => {
    const { call, calls } = setup({ answer: approve({}) })
    await call('reply_to_conversation', { conversationId: 'PRRT_1', text: 'Done.', resolve: true })
    expect(calls.map((c) => c.op)).toEqual(['reply', 'resolve'])
    expect(calls[0].input).toEqual({ conversationId: 'PRRT_1', body: 'Done.\n\nvia Switchboard' })
  })

  it('shows the card in full access too, because it posts as the user', async () => {
    const { call, events } = setup({ mode: 'full-access', answer: approve({}) })
    await call('reply_to_conversation', { conversationId: 'PRRT_1', text: 'Done.' })
    expect(opened(events)).toHaveLength(1)
  })

  it('is refused in plan mode without a card', async () => {
    const { call, events, calls } = setup({ mode: 'plan' })
    const result = await call('reply_to_conversation', { conversationId: 'PRRT_1', text: 'Done.' })
    expect(result.isError).toBe(true)
    expect(opened(events)).toEqual([])
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.denied', toolName: 'mcp__switchboard__reply_to_conversation', mode: 'plan' }))
    expect(calls).toEqual([])
  })

  it('posts nothing when the user denies', async () => {
    const { call, calls } = setup({ answer: deny })
    const result = await call('reply_to_conversation', { conversationId: 'PRRT_1', text: 'Done.' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Nothing was posted')
    expect(calls).toEqual([])
  })

  it('refuses an edit the user emptied or made too long', async () => {
    const { call, calls } = setup({ answer: approve({ text: '   ' }) })
    const result = await call('reply_to_conversation', { conversationId: 'PRRT_1', text: 'Done.' })
    expect(result.isError).toBe(true)
    expect(calls).toEqual([])
  })

  it('refuses an oversized draft before any card', async () => {
    const { call, events } = setup()
    const result = await call('reply_to_conversation', { conversationId: 'PRRT_1', text: 'x'.repeat(9_000) })
    expect(result.isError).toBe(true)
    expect(opened(events)).toEqual([])
  })

  it('refuses a conversation that is not on the PR', async () => {
    const { call, events } = setup()
    const result = await call('reply_to_conversation', { conversationId: 'gone', text: 'Done.' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('list_pr_conversations')
    expect(opened(events)).toEqual([])
  })

  it('stops at the budget, with a refusal the model can read', async () => {
    const { call, events } = setup({ answer: deny, budget: new AgentWriteBudget(1) })
    await call('reply_to_conversation', { conversationId: 'PRRT_1', text: 'one' })
    const second = await call('reply_to_conversation', { conversationId: 'PRRT_1', text: 'two' })
    expect(second.isError).toBe(true)
    expect(text(second)).toContain('limit')
    expect(opened(events)).toHaveLength(1)
  })

  it('charges the budget only for a write that reaches its card', async () => {
    const { call, events } = setup({ answer: deny, budget: new AgentWriteBudget(1) })
    await call('reply_to_conversation', { conversationId: 'gone', text: 'one' })
    await call('reply_to_conversation', { conversationId: 'PRRT_1', text: 'two' })
    expect(opened(events)).toHaveLength(1)
  })

  it('says the reply was posted when only the resolve failed, so it is not posted again', async () => {
    const { call, access } = setup({ answer: approve({ resolve: true }) })
    vi.mocked(access.setResolved).mockResolvedValueOnce({ ok: false, error: { kind: 'forbidden', host: 'github', message: 'No permission.' } })
    const result = await call('reply_to_conversation', { conversationId: 'PRRT_1', text: 'Done.' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Do not post the reply again')
  })
})

describe('a call the agent cancels after the approval', () => {
  it('posts nothing, since the agent would never hear it happened', async () => {
    const controller = new AbortController()
    const { tools, calls } = setup({
      answer: () => {
        queueMicrotask(() => controller.abort())
        return { decision: 'approve' as const, response: {} }
      },
    })
    const reply = tools.find((t) => t.name === 'reply_to_conversation')!
    await reply.call({ conversationId: 'PRRT_1', text: 'Done.' }, { signal: controller.signal })
    expect(calls).toEqual([])
  })
})

describe('resolve_conversation', () => {
  it('resolves after the card', async () => {
    const { call, calls, events } = setup({ answer: approve() })
    await call('resolve_conversation', { conversationId: 'PRRT_1' })
    expect(opened(events)[0].hostWrite?.action).toBe('resolve')
    expect(calls).toEqual([{ op: 'resolve', ref: PR, input: { conversationId: 'PRRT_1' }, resolved: true }])
  })
})

describe('rerun_check', () => {
  it('re-runs a failed Actions check after the card', async () => {
    const { call, calls, events } = setup({ answer: approve() })
    await call('rerun_check', { checkId: 'chk1' })
    expect(opened(events)[0].hostWrite).toMatchObject({ action: 'rerun', checkName: 'integration' })
    expect(calls).toEqual([{ op: 'rerun', ref: PR, input: { checkId: 'chk1' } }])
  })

  it('refuses on Bitbucket, which cannot re-run, before any card', async () => {
    const bb: PrRef = { host: 'bitbucket', owner: 'acme', name: 'app', number: 612 }
    const { call, events } = setup({ linked: [bb] })
    const result = await call('rerun_check', { checkId: 'chk1' })
    expect(result.isError).toBe(true)
    expect(opened(events)).toEqual([])
  })
})
