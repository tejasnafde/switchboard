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
import type { PrChangedFile, PrCheck, PrConversation, PrDetail, PrRef } from '../../src/shared/pull-requests'
import { parseHunks } from '../../src/shared/unified-diff'
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

const WORKER_DIFF = [
  '@@ -80,4 +80,5 @@ class SyncWorker:',
  '     def run_once(self, attempt: int) -> None:',
  '-        time.sleep(30)',
  '+        delay = next_delay(attempt)',
  '+        time.sleep(delay)',
  '         return self.poll()',
].join('\n')

const changedFiles: PrChangedFile[] = [
  { path: 'sync/worker.py', oldPath: null, status: 'modified', additions: 2, deletions: 1, binary: false, truncated: false, hunks: parseHunks(WORKER_DIFF).hunks },
]

/** The worker diff plus a second hunk far below it, so a range can cross hunks. */
const twoHunkFiles: PrChangedFile[] = [{
  ...changedFiles[0],
  hunks: parseHunks([WORKER_DIFF, '@@ -120,2 +121,3 @@ class SyncWorker:', '     def stop(self) -> None:', '+        self.closed = True', '         return None'].join('\n')).hunks,
}]

function detail(): PrDetail {
  return {
    ref: PR, title: 'Sync backoff', url: 'https://github.com/acme/app/pull/612',
    author: { login: 'tejas', displayName: 'Tejas', avatarUrl: null }, state: 'open', draft: false,
    sourceBranch: 'backoff', targetBranch: 'main', createdAt: 0, updatedAt: 0, mergedAt: null,
    additions: 1, deletions: 1, changedFiles: 1, unresolvedConversations: 1,
    checks: { state: 'failure', total: 1, passed: 0, failed: 1, pending: 0 },
    reviewers: [], approvals: { given: 0, required: 1 }, viewer: { isAuthor: true, isRequestedReviewer: false, hasReviewed: false, hasCommented: false },
    projectPaths: ['/p'], description: 'body', headSha: 'abc', mergeBlockers: [{ kind: 'checks_failed', label: 'Checks failed' }],
    mergeStrategies: ['merge_commit'], activity: [], checkList: [failedCheck],
  }
}

function fakeAccess(linked: PrRef[] = [PR], over: Partial<PrDetail> = {}, diff: PrChangedFile[] = changedFiles) {
  const calls: Array<{ op: string; ref: PrRef; input?: unknown; resolved?: boolean }> = []
  const ok = { ok: true as const, data: { refresh: [] } }
  const access: AgentPullRequestAccess = {
    linkedPrs: vi.fn(() => linked),
    detail: vi.fn(async () => ({ ok: true as const, data: { ...detail(), ...over } })),
    conversations: vi.fn(async () => ({ ok: true as const, data: [conversation] })),
    files: vi.fn(async () => ({ ok: true as const, data: diff })),
    reply: vi.fn(async (ref, input) => { calls.push({ op: 'reply', ref, input }); return ok }),
    setResolved: vi.fn(async (ref, input, resolved) => { calls.push({ op: 'resolve', ref, input, resolved }); return ok }),
    rerunCheck: vi.fn(async (ref, input) => { calls.push({ op: 'rerun', ref, input }); return ok }),
    inlineComment: vi.fn(async (ref, input) => { calls.push({ op: 'comment', ref, input }); return ok }),
    submitReview: vi.fn(async (ref, input) => { calls.push({ op: 'review', ref, input }); return ok }),
  }
  return { access, calls }
}

function setup(opts: { mode?: RuntimeMode; linked?: PrRef[]; detail?: Partial<PrDetail>; files?: PrChangedFile[]; answer?: (card: Extract<RuntimeEvent, { type: 'request.opened' }>) => AgentApprovalOutcome | null; budget?: AgentWriteBudget } = {}) {
  const events: RuntimeEvent[] = []
  const { access, calls } = fakeAccess(opts.linked, opts.detail, opts.files)
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
    runtimeMode: () => mode,
    publish: (e) => events.push(e),
    approvals,
    budget: opts.budget ?? new AgentWriteBudget(),
    pullRequests: access,
  })
  const tool = (name: string): McpTool => tools.find((t) => t.name === name)!
  const call = (name: string, args: Record<string, unknown>) => tool(name).call(args, { signal: new AbortController().signal })
  return { tools, call, events, access, calls, setMode: (m: RuntimeMode) => { mode = m } }
}

const approve = (response = {}) => () => ({ decision: 'approve' as const, response })
const deny = () => ({ decision: 'deny' as const, reason: 'user' as const })
const opened = (events: RuntimeEvent[]) => events.filter((e) => e.type === 'request.opened') as Array<Extract<RuntimeEvent, { type: 'request.opened' }>>
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text

describe('the tool list', () => {
  it('has the three reads and five writes, annotated, and nothing that approves or merges', () => {
    const { tools } = setup()
    expect(tools.map((t) => [t.name, t.annotations.readOnlyHint])).toEqual([
      ['get_pr_status', true],
      ['list_pr_conversations', true],
      ['get_pr_diff', true],
      ['reply_to_conversation', false],
      ['resolve_conversation', false],
      ['rerun_check', false],
      ['comment_on_line', false],
      ['draft_review', false],
    ])
    expect(tools.some((t) => /approve|merge|request_changes/.test(t.name))).toBe(false)
  })

  it('gives draft_review no verdict argument, and tells the model to read the diff first and that the user picks the verdict', () => {
    const { tools } = setup()
    const review = tools.find((t) => t.name === 'draft_review')!
    const props = review.inputSchema.properties as Record<string, unknown>
    expect(Object.keys(props).sort()).toEqual(['comments', 'pr', 'summary'])
    expect(JSON.stringify(review.inputSchema)).not.toMatch(/verdict|approve|request_changes|"event"/)
    expect(review.description).toContain('get_pr_diff first')
    expect(review.description).toContain('Prefer ONE draft_review')
    expect(review.description).toMatch(/picks the verdict\s+themselves/)
    const comment = tools.find((t) => t.name === 'comment_on_line')!
    expect(comment.description).toContain('get_pr_diff first')
    expect(comment.description).toContain('prefer ONE draft_review')
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

  it('names both ends of a conversation on a range of lines', async () => {
    const { call, access } = setup()
    vi.mocked(access.conversations).mockResolvedValue({ ok: true, data: [{ ...conversation, startLine: 84 }] })
    const body = JSON.parse(text(await call('list_pr_conversations', {})))
    expect(body[0].location).toBe('sync/worker.py:84-88')
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

describe('what changed while the card was open', () => {
  it('posts nothing when the user unlinked the PR before approving', async () => {
    let access: AgentPullRequestAccess | null = null
    const ctx = setup({ answer: () => { vi.mocked(access!.linkedPrs).mockReturnValue([]); return { decision: 'approve' as const, response: {} } } })
    access = ctx.access
    const result = await ctx.call('reply_to_conversation', { conversationId: 'PRRT_1', text: 'Done.' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unlinked')
    expect(ctx.calls).toEqual([])
  })

  it('posts nothing when the chat switched to plan mode before the approval', async () => {
    let switchToPlan: () => void = () => {}
    const ctx = setup({ answer: () => { switchToPlan(); return { decision: 'approve' as const, response: {} } } })
    switchToPlan = () => ctx.setMode('plan')
    const result = await ctx.call('resolve_conversation', { conversationId: 'PRRT_1' })
    expect(result.isError).toBe(true)
    expect(ctx.events).toContainEqual(expect.objectContaining({ type: 'tool.denied', mode: 'plan' }))
    expect(ctx.calls).toEqual([])
  })

  it('posts the reply but does not resolve when the chat switched to plan mode during the post', async () => {
    const ctx = setup({ answer: () => ({ decision: 'approve' as const, response: { resolve: true } }) })
    const post = ctx.access.reply
    vi.mocked(post).mockImplementation(async (ref, input) => {
      ctx.calls.push({ op: 'reply', ref, input })
      ctx.setMode('plan')
      return { ok: true } as Awaited<ReturnType<typeof post>>
    })
    const result = await ctx.call('reply_to_conversation', { conversationId: 'PRRT_1', text: 'Done.', resolve: true })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('did not resolve')
    expect(ctx.calls.map((c) => c.op)).toEqual(['reply'])
  })

  it('re-runs nothing when the PR was unlinked', async () => {
    let access: AgentPullRequestAccess | null = null
    const ctx = setup({ answer: () => { vi.mocked(access!.linkedPrs).mockReturnValue([OTHER]); return { decision: 'approve' as const, response: {} } } })
    access = ctx.access
    expect((await ctx.call('rerun_check', { checkId: 'chk1' })).isError).toBe(true)
    expect(ctx.calls).toEqual([])
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

describe('get_pr_diff', () => {
  it('returns the changed lines with their numbers, without a card, in plan mode too', async () => {
    const { call, events, access } = setup({ mode: 'plan' })
    const result = await call('get_pr_diff', {})
    expect(result.isError).toBeUndefined()
    expect(text(result)).toContain('Diff of GitHub acme/app #612.')
    expect(text(result)).toContain('=== sync/worker.py (modified, +2 -1)')
    expect(text(result)).toMatch(/\+\s+81 \| +delay = next_delay\(attempt\)/)
    expect(access.files).toHaveBeenCalledWith(PR)
    expect(opened(events)).toEqual([])
    expect(events.some((e) => e.type === 'tool.denied')).toBe(false)
  })

  it('refuses a filter that matches nothing, naming the changed files', async () => {
    const result = await setup().call('get_pr_diff', { path: 'docs' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('sync/worker.py')
  })

  it('refuses a PR that is not linked', async () => {
    const { call, access } = setup()
    expect((await call('get_pr_diff', { pr: 99 })).isError).toBe(true)
    expect(access.files).not.toHaveBeenCalled()
  })
})

describe('comment_on_line', () => {
  const args = { path: 'sync/worker.py', line: 81, side: 'new', text: 'Log the delay.' }

  it('opens one card with the line and the diff around it, and posts the edited text with the marker', async () => {
    const { call, events, calls } = setup({ answer: approve({ text: 'Log the delay, please.' }) })
    const result = await call('comment_on_line', args)
    const cards = opened(events)
    expect(cards).toHaveLength(1)
    expect(cards[0].toolName).toBe('mcp__switchboard__comment_on_line')
    expect(cards[0].hostWrite).toMatchObject({ action: 'comment', location: 'sync/worker.py:81', replyText: 'Log the delay.' })
    const excerpt = cards[0].hostWrite!.excerpt!
    expect(excerpt.find((l) => l.target)).toMatchObject({ kind: 'add', newLine: 81 })
    expect(excerpt.length).toBeGreaterThan(1)
    expect(calls).toEqual([{ op: 'comment', ref: PR, input: { path: 'sync/worker.py', side: 'new', line: 81, body: 'Log the delay, please.\n\nvia Switchboard' } }])
    expect(text(result)).toContain('edited your comment')
  })

  it('takes a range: a card that says which lines and marks them all, and the range sent to the host', async () => {
    const { call, events, calls } = setup({ answer: approve() })
    const result = await call('comment_on_line', { ...args, startLine: 80, line: 82 })
    const card = opened(events)[0].hostWrite!
    expect(card).toMatchObject({ action: 'comment', location: 'sync/worker.py:80-82', lineRange: { start: 80, end: 82 } })
    expect(card.excerpt!.filter((l) => l.target).map((l) => l.newLine)).toEqual([80, 81, 82])
    expect(opened(events)[0].detail).toContain('Comment on app #612 · sync/worker.py:80-82')
    expect(calls).toEqual([{ op: 'comment', ref: PR, input: { path: 'sync/worker.py', side: 'new', line: 82, startLine: 80, body: 'Log the delay.\n\nvia Switchboard' } }])
    expect(text(result)).toContain('sync/worker.py:80-82')
  })

  it('refuses a reversed, too long, mixed-side or cross-hunk range, before any card', async () => {
    const { call, events, calls } = setup({ answer: approve(), files: twoHunkFiles })
    const reversed = await call('comment_on_line', { ...args, startLine: 82, line: 80 })
    expect(text(reversed)).toContain('"line" is the LAST line')
    expect((await call('comment_on_line', { ...args, startLine: 1, line: 201 })).isError).toBe(true)
    expect((await call('comment_on_line', { ...args, startLine: 80, line: 82, startSide: 'old' })).isError).toBe(true)
    const split = await call('comment_on_line', { ...args, startLine: 81, line: 122 })
    expect(split.isError).toBe(true)
    expect(text(split)).toContain('spans two hunks')
    expect(opened(events)).toEqual([])
    expect(calls).toEqual([])
    // Inside the second hunk is fine.
    await call('comment_on_line', { ...args, startLine: 121, line: 123 })
    expect(calls.map((c) => c.input)).toEqual([expect.objectContaining({ line: 123, startLine: 121 })])
  })

  it('takes a deleted line on the old side', async () => {
    const { call, calls } = setup({ answer: approve() })
    await call('comment_on_line', { ...args, line: 81, side: 'old' })
    expect(calls[0].input).toMatchObject({ side: 'old', line: 81 })
  })

  it('refuses a line the diff does not show, before any card', async () => {
    const { call, events, calls } = setup({ answer: approve() })
    const result = await call('comment_on_line', { ...args, line: 120 })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('get_pr_diff')
    expect(opened(events)).toEqual([])
    expect(calls).toEqual([])
    // An added line has no number on the old side.
    expect((await call('comment_on_line', { ...args, line: 83, side: 'old' })).isError).toBe(true)
  })

  it('refuses a missing path or line and an oversized comment, before any card', async () => {
    const { call, events } = setup()
    expect((await call('comment_on_line', { ...args, path: '' })).isError).toBe(true)
    expect((await call('comment_on_line', { ...args, line: 0 })).isError).toBe(true)
    expect((await call('comment_on_line', { ...args, side: 'left' })).isError).toBe(true)
    expect((await call('comment_on_line', { ...args, text: 'x'.repeat(8_001) })).isError).toBe(true)
    expect(opened(events)).toEqual([])
  })

  it('is refused in plan mode without a card, and carded in full access', async () => {
    const plan = setup({ mode: 'plan' })
    expect((await plan.call('comment_on_line', args)).isError).toBe(true)
    expect(opened(plan.events)).toEqual([])
    expect(plan.events).toContainEqual(expect.objectContaining({ type: 'tool.denied', toolName: 'mcp__switchboard__comment_on_line' }))
    const full = setup({ mode: 'full-access', answer: approve() })
    await full.call('comment_on_line', args)
    expect(opened(full.events)).toHaveLength(1)
    expect(full.calls.map((c) => c.op)).toEqual(['comment'])
  })

  it('posts nothing on deny, on an emptied edit, or once the PR was unlinked', async () => {
    const denied = setup({ answer: deny })
    expect((await denied.call('comment_on_line', args)).isError).toBe(true)
    expect(denied.calls).toEqual([])
    const emptied = setup({ answer: approve({ text: ' ' }) })
    expect((await emptied.call('comment_on_line', args)).isError).toBe(true)
    expect(emptied.calls).toEqual([])
    let access: AgentPullRequestAccess | null = null
    const unlinked = setup({ answer: () => { vi.mocked(access!.linkedPrs).mockReturnValue([]); return { decision: 'approve' as const, response: {} } } })
    access = unlinked.access
    expect((await unlinked.call('comment_on_line', args)).isError).toBe(true)
    expect(unlinked.calls).toEqual([])
  })

  it('counts against the chat budget', async () => {
    const { call, events } = setup({ answer: deny, budget: new AgentWriteBudget(1) })
    await call('comment_on_line', args)
    const second = await call('comment_on_line', args)
    expect(text(second)).toContain('limit')
    expect(opened(events)).toHaveLength(1)
  })
})

describe('draft_review', () => {
  const draft = {
    summary: 'Looks right; two notes.',
    comments: [
      { path: 'sync/worker.py', line: 81, side: 'new', text: 'Log the delay.' },
      { path: 'sync/worker.py', line: 82, text: 'Jitter?' },
    ],
  }
  const reviewer = { viewer: { isAuthor: false, isRequestedReviewer: true, hasReviewed: false, hasCommented: false } }

  it('opens ONE card with every comment, its place and a diff excerpt, and no verdict chosen', async () => {
    const { call, events } = setup({ detail: reviewer, answer: deny })
    await call('draft_review', draft)
    const cards = opened(events)
    expect(cards).toHaveLength(1)
    expect(cards[0].toolName).toBe('mcp__switchboard__draft_review')
    const review = cards[0].hostWrite!.review!
    expect(review.summary).toBe('Looks right; two notes.')
    expect(review.comments.map((c) => [c.id, c.path, c.line, c.side, c.text])).toEqual([
      ['c1', 'sync/worker.py', 81, 'new', 'Log the delay.'],
      ['c2', 'sync/worker.py', 82, 'new', 'Jitter?'],
    ])
    expect(review.comments[0].excerpt.find((l) => l.target)?.newLine).toBe(81)
    expect(review.verdicts).toEqual(['comment', 'approve', 'request_changes'])
    expect(review.commentOnly).toBeUndefined()
    expect(cards[0].detail).toContain('sync/worker.py:81: Log the delay.')
  })

  it('submits with the verdict the USER picked, the kept comments as edited, each with the marker', async () => {
    const { call, calls } = setup({
      detail: reviewer,
      answer: approve({ verdict: 'request_changes', summary: 'Please log the delay.', comments: [{ id: 'c1', text: 'Log it here.' }] }),
    })
    const result = await call('draft_review', draft)
    expect(calls).toEqual([{
      op: 'review',
      ref: PR,
      input: {
        event: 'request_changes',
        body: 'Please log the delay.\n\nvia Switchboard',
        comments: [{ path: 'sync/worker.py', side: 'new', line: 81, body: 'Log it here.\n\nvia Switchboard' }],
      },
    }])
    expect(text(result)).toContain('as Request changes, with 1 inline comments')
    expect(text(result)).toContain('removed 1 of your comments')
  })

  it('carries a range comment into the card row and the submitted review', async () => {
    const ranged = { ...draft, comments: [{ path: 'sync/worker.py', startLine: 80, line: 82, text: 'This block.' }] }
    const { call, events, calls } = setup({ detail: reviewer, answer: approve({ verdict: 'comment' }) })
    await call('draft_review', ranged)
    const card = opened(events)[0]
    const row = card.hostWrite!.review!.comments[0]
    expect(row).toMatchObject({ line: 82, startLine: 80 })
    expect(row.excerpt.filter((l) => l.target).map((l) => l.newLine)).toEqual([80, 81, 82])
    expect(card.detail).toContain('sync/worker.py:80-82: This block.')
    expect(calls[0].input).toMatchObject({ comments: [{ path: 'sync/worker.py', side: 'new', line: 82, startLine: 80, body: 'This block.\n\nvia Switchboard' }] })
  })

  it('refuses a draft with a range across two hunks, naming it, before any card', async () => {
    const { call, events } = setup({ detail: reviewer, answer: approve({ verdict: 'comment' }), files: twoHunkFiles })
    const result = await call('draft_review', { ...draft, comments: [{ path: 'sync/worker.py', startLine: 81, line: 122, text: 'x' }] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('sync/worker.py:81-122 (spans two hunks)')
    expect(opened(events)).toEqual([])
  })

  it('posts nothing when the card answered without a verdict (a plain approval)', async () => {
    const { call, calls } = setup({ detail: reviewer, answer: approve({}) })
    const result = await call('draft_review', draft)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('without a verdict')
    expect(calls).toEqual([])
  })

  it('refuses a verdict among the agent\'s arguments, before any card', async () => {
    for (const key of ['verdict', 'event', 'approve']) {
      const { call, events } = setup({ detail: reviewer, answer: approve({ verdict: 'comment' }) })
      const result = await call('draft_review', { ...draft, [key]: key === 'approve' ? true : 'approve' })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('the user picks')
      expect(opened(events)).toEqual([])
    }
  })

  it('offers the author Comment only, and refuses an Approve the card should not have sent', async () => {
    const { call, events, calls } = setup({ answer: approve({ verdict: 'approve', summary: 'LGTM' }) })
    const result = await call('draft_review', draft)
    expect(opened(events)[0].hostWrite!.review).toMatchObject({ verdicts: ['comment'], commentOnly: 'author' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('own pull request')
    expect(calls).toEqual([])
  })

  it('lets the author submit a Comment review on their own PR', async () => {
    const { call, calls } = setup({ answer: approve({ verdict: 'comment' }) })
    await call('draft_review', draft)
    expect(calls).toHaveLength(1)
    expect(calls[0].input).toMatchObject({ event: 'comment', body: 'Looks right; two notes.\n\nvia Switchboard' })
  })

  it('offers Comment only on a PR that is not open', async () => {
    const { call, events } = setup({ detail: { ...reviewer, state: 'merged' }, answer: deny })
    await call('draft_review', draft)
    expect(opened(events)[0].hostWrite!.review).toMatchObject({ verdicts: ['comment'], commentOnly: 'closed' })
  })

  it('refuses comments on lines the diff does not show, naming all of them, before any card', async () => {
    const { call, events } = setup({ detail: reviewer })
    const result = await call('draft_review', { ...draft, comments: [...draft.comments, { path: 'sync/worker.py', line: 500, text: 'a' }, { path: 'nope.py', line: 1, text: 'b' }] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('sync/worker.py:500, nope.py:1')
    expect(opened(events)).toEqual([])
  })

  it('refuses a draft over the caps, before any card', async () => {
    const { call, events } = setup({ detail: reviewer })
    const many = Array.from({ length: 31 }, () => ({ path: 'sync/worker.py', line: 81, text: 'x' }))
    expect(text(await call('draft_review', { summary: 's', comments: many }))).toContain('at most 30')
    expect((await call('draft_review', { summary: 's', comments: [{ path: 'sync/worker.py', line: 81, text: 'x'.repeat(8_001) }] })).isError).toBe(true)
    const big = Array.from({ length: 6 }, () => ({ path: 'sync/worker.py', line: 81, text: 'x'.repeat(7_000) }))
    expect(text(await call('draft_review', { summary: 's', comments: big }))).toContain('KiB')
    expect((await call('draft_review', { summary: '', comments: [] })).isError).toBe(true)
    expect(opened(events)).toEqual([])
  })

  it('is refused in plan mode without a card, and carded in full access', async () => {
    const plan = setup({ mode: 'plan', detail: reviewer })
    expect((await plan.call('draft_review', draft)).isError).toBe(true)
    expect(opened(plan.events)).toEqual([])
    expect(plan.events).toContainEqual(expect.objectContaining({ type: 'tool.denied', toolName: 'mcp__switchboard__draft_review' }))
    const full = setup({ mode: 'full-access', detail: reviewer, answer: approve({ verdict: 'approve' }) })
    await full.call('draft_review', draft)
    expect(opened(full.events)).toHaveLength(1)
    expect(full.calls.map((c) => c.op)).toEqual(['review'])
  })

  it('posts nothing on deny', async () => {
    const { call, calls } = setup({ detail: reviewer, answer: deny })
    expect(text(await call('draft_review', draft))).toContain('Nothing was posted')
    expect(calls).toEqual([])
  })

  it('counts as ONE write against the budget, however many comments it holds', async () => {
    const budget = new AgentWriteBudget(2)
    const { call, calls } = setup({ detail: reviewer, budget, answer: approve({ verdict: 'comment' }) })
    await call('draft_review', draft)
    expect(calls).toHaveLength(1)
    expect(budget.take('root-1').ok).toBe(true)
    expect(budget.take('root-1').ok).toBe(false)
  })

  it('posts nothing when the mode switched to plan or the PR was unlinked while the card was open', async () => {
    let switchToPlan: () => void = () => {}
    const plan = setup({ detail: reviewer, answer: () => { switchToPlan(); return { decision: 'approve' as const, response: { verdict: 'comment' } } } })
    switchToPlan = () => plan.setMode('plan')
    expect((await plan.call('draft_review', draft)).isError).toBe(true)
    expect(plan.calls).toEqual([])

    let access: AgentPullRequestAccess | null = null
    const unlinked = setup({ detail: reviewer, answer: () => { vi.mocked(access!.linkedPrs).mockReturnValue([OTHER]); return { decision: 'approve' as const, response: { verdict: 'comment' } } } })
    access = unlinked.access
    expect(text(await unlinked.call('draft_review', draft))).toContain('unlinked')
    expect(unlinked.calls).toEqual([])
  })

  it('refuses an answer that empties a kept comment, or a change request without a summary', async () => {
    const emptied = setup({ detail: reviewer, answer: approve({ verdict: 'comment', comments: [{ id: 'c1', text: '  ' }] }) })
    expect((await emptied.call('draft_review', draft)).isError).toBe(true)
    expect(emptied.calls).toEqual([])
    const noSummary = setup({ detail: reviewer, answer: approve({ verdict: 'request_changes', summary: '' }) })
    expect((await noSummary.call('draft_review', draft)).isError).toBe(true)
    expect(noSummary.calls).toEqual([])
  })

  it('ignores a comment id the card never showed', async () => {
    const { call, calls } = setup({ detail: reviewer, answer: approve({ verdict: 'comment', comments: [{ id: 'c9', text: 'smuggled' }, { id: 'c2', text: 'Jitter?' }] }) })
    await call('draft_review', draft)
    expect((calls[0].input as { comments: unknown[] }).comments).toEqual([{ path: 'sync/worker.py', side: 'new', line: 82, body: 'Jitter?\n\nvia Switchboard' }])
  })

  it('says how many comments went out when a Bitbucket review failed part way', async () => {
    const { call, access } = setup({ detail: reviewer, answer: approve({ verdict: 'approve' }) })
    vi.mocked(access.submitReview).mockResolvedValueOnce({ ok: false, error: { kind: 'unknown', host: 'bitbucket', message: 'Approve failed.', postedComments: 2 } })
    const result = await call('draft_review', draft)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('2 of its comments were posted. Do not submit it again')
  })
})

describe('replies on a pull request the user did not write', () => {
  const others = { viewer: { isAuthor: false, isRequestedReviewer: true, hasReviewed: true, hasCommented: false }, author: { login: 'akshaya', displayName: 'Akshaya', avatarUrl: null } }

  it('replies and resolves, since neither the link nor the author rules look at who wrote it', async () => {
    const { call, calls } = setup({ detail: others, answer: approve({ text: 'Agreed, changed.', resolve: true }) })
    const result = await call('reply_to_conversation', { conversationId: 'PRRT_1', text: 'Agreed, changed.' })
    expect(result.isError).toBeUndefined()
    expect(calls.map((c) => c.op)).toEqual(['reply', 'resolve'])
    const resolved = setup({ detail: others, answer: approve() })
    await resolved.call('resolve_conversation', { conversationId: 'PRRT_1' })
    expect(resolved.calls.map((c) => c.op)).toEqual(['resolve'])
  })
})
