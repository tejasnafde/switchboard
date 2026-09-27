/**
 * The review store around writes: line comments held for a review, the
 * optimistic resolve that flips back when the host refuses, and the re-read
 * after a write that keeps the shown tabs until the fresh answer arrives.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prKey, rollupChecks, type PrConversation, type PrListData, type PrSummary } from '../../src/shared/pull-requests'

vi.mock('../../src/renderer/logger', () => ({ createRendererLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))

const summary = (updatedAt: number): PrSummary => ({
  ref: { host: 'github', owner: 'o', name: 'r', number: 1 }, title: 'PR', url: '', author: { login: 'a', displayName: 'a', avatarUrl: null },
  state: 'open', draft: false, sourceBranch: 'f', targetBranch: 'main', createdAt: 0, updatedAt, mergedAt: null,
  additions: null, deletions: null, changedFiles: null, unresolvedConversations: 1, checks: rollupChecks([]),
  reviewers: [], approvals: { given: 0, required: null }, viewer: { isAuthor: false, isRequestedReviewer: true, hasReviewed: false }, projectPaths: [],
})
const list = (updatedAt: number): PrListData => ({ prs: [summary(updatedAt)], sources: [], unsupportedProjects: [], fetchedAt: 0 })
const thread = (resolved: boolean): PrConversation => ({ id: 'PRRT_1', path: 'a.ts', line: 1, side: 'new', resolved, outdated: false, comments: [] })
const ref = summary(1).ref
const key = prKey(ref)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function store(api: Record<string, unknown>) {
  vi.stubGlobal('window', { api: { pullRequests: { list: async () => ({ ok: true, data: list(2) }), ...api } } })
  const mod = await import('../../src/renderer/stores/review-store')
  mod.useReviewStore.setState({
    list: list(1), visible: true, lastFetchAt: null, loading: false,
    resources: { [key]: { conversations: { status: 'ok', data: [thread(false)], version: 1 } } },
    pendingComments: {}, mergeStrategy: {},
  })
  return mod.useReviewStore
}

describe('pending review comments', () => {
  it('holds, removes and drops the posted ones first', async () => {
    const s = await store({})
    const add = (line: number) => s.getState().addPendingComment(ref, { path: 'a.ts', side: 'new', line, body: `c${line}` })
    add(1); add(2); add(3)
    const ids = s.getState().pendingComments[key].map((c) => c.id)
    expect(new Set(ids).size).toBe(3)
    s.getState().removePendingComment(ref, ids[1])
    expect(s.getState().pendingComments[key].map((c) => c.line)).toEqual([1, 3])
    s.getState().dropPendingComments(ref, 1)
    expect(s.getState().pendingComments[key].map((c) => c.line)).toEqual([3])
    s.getState().dropPendingComments(ref)
    expect(s.getState().pendingComments[key]).toEqual([])
  })
})

describe('resolve', () => {
  it('flips the thread at once and keeps it when the host agrees', async () => {
    let answer!: (v: unknown) => void
    const resolve = vi.fn(() => new Promise((r) => { answer = r }))
    const conversations = vi.fn(async () => ({ ok: true, data: [thread(true)] }))
    const s = await store({ resolve, conversations, detail: async () => ({ ok: false, error: { kind: 'unknown', host: null, message: 'x' } }) })
    const { toggleResolved } = await import('../../src/renderer/components/reviews/review-writes')
    const done = toggleResolved(ref, thread(false))
    const shown = () => { const c = s.getState().resources[key]?.conversations; return c?.status === 'ok' ? c.data[0].resolved : null }
    expect(shown()).toBe(true)
    answer({ ok: true, data: { refresh: ['conversations'] } })
    expect(await done).toBeNull()
    expect(resolve).toHaveBeenCalledWith(ref, { conversationId: 'PRRT_1' })
    expect(conversations).toHaveBeenCalled()
    expect(shown()).toBe(true)
  })

  it('flips it back when the host refuses', async () => {
    const s = await store({ resolve: async () => ({ ok: false, error: { kind: 'forbidden', host: 'github', message: 'No permission.' } }) })
    const { toggleResolved } = await import('../../src/renderer/components/reviews/review-writes')
    const error = await toggleResolved(ref, thread(false))
    expect(error).toMatchObject({ kind: 'forbidden' })
    const c = s.getState().resources[key]?.conversations
    expect(c?.status === 'ok' && c.data[0].resolved).toBe(false)
  })
})

describe('afterWrite', () => {
  it('keeps the written PR on screen through the list refresh and re-reads what the write changed', async () => {
    const conversations = vi.fn(async () => ({ ok: true, data: [thread(false), { ...thread(false), id: 'PRRT_2' }] }))
    const s = await store({ conversations })
    const pending = s.getState().afterWrite(ref, ['conversations', 'detail'])
    await Promise.resolve()
    // The list says the PR changed; its tabs are kept, not dropped to Loading.
    expect(s.getState().resources[key]?.conversations?.status).toBe('ok')
    await pending
    const c = s.getState().resources[key]?.conversations
    expect(c?.status === 'ok' && c.data.length).toBe(2)
    // `detail` was never loaded here, so the write does not start reading it.
    expect(s.getState().resources[key]?.detail).toBeUndefined()
  })
})
