import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentApprovalBroker } from '../../src/main/mcp/agent-approvals'
import { AgentWriteBudget } from '../../src/main/mcp/agent-write-budget'
import type { RuntimeEvent } from '../../src/shared/provider-events'
import type { HostWriteCard } from '../../src/shared/agent-host-writes'
import { HOST_WRITE_SHOWN_REQUIRED, hostWriteShownDigest } from '../../src/shared/host-write-phone'

const card: HostWriteCard = {
  action: 'reply', agentLabel: 'Codex', host: 'github', prLabel: 'repo #1', target: { repository: 'acme/repo', number: 1 }, url: null,
  location: 'a.ts:1', quote: null, replyText: 'done', maxChars: 8000,
}

const DESKTOP = { mayApproveHostWrite: true, label: 'the desktop' }
const NO_SCOPE = { mayApproveHostWrite: false, label: 'device session d0' }
const PHONE = { mayApproveHostWrite: true, mustProveShown: true, label: 'device session d1' }

const reviewCard: HostWriteCard = {
  ...card, action: 'review', location: null, replyText: undefined,
  review: { summary: 'Two notes.', comments: [], verdicts: ['comment'], commentOnly: 'author' },
}

function broker(ttlMs?: number) {
  const events: RuntimeEvent[] = []
  const b = new AgentApprovalBroker({
    publish: (e) => events.push(e),
    sameChat: (a, c) => a.replace('rotated-', '') === c.replace('rotated-', ''),
    ...(ttlMs ? { ttlMs } : {}),
  })
  const opened = () => events.find((e) => e.type === 'request.opened') as Extract<RuntimeEvent, { type: 'request.opened' }>
  return { b, events, opened }
}

afterEach(() => vi.useRealTimers())

describe('AgentApprovalBroker', () => {
  it('opens a card on the chat and returns the approval with the edited text', async () => {
    const { b, events, opened } = broker()
    const answer = b.ask({ threadId: 't1', toolName: 'mcp__switchboard__reply_to_conversation', detail: 'd', hostWrite: card })
    expect(opened()).toMatchObject({ threadId: 't1', requestType: 'tool', hostWrite: card })
    expect(AgentApprovalBroker.owns(opened().requestId)).toBe(true)
    expect(b.respond('t1', opened().requestId, 'approve', { text: 'edited', resolve: true }, DESKTOP)).toEqual({ ok: true })
    await expect(answer).resolves.toEqual({ decision: 'approve', response: { text: 'edited', resolve: true } })
    expect(events.at(-1)).toEqual({ type: 'request.closed', threadId: 't1', requestId: opened().requestId, decision: 'approve' })
  })

  it('refuses a host write approval from a device that cannot write to a host, and keeps the card open', async () => {
    const { b, opened } = broker()
    const answer = b.ask({ threadId: 't1', toolName: 'x', detail: 'd', hostWrite: card })
    const refused = b.respond('t1', opened().requestId, 'approve', {}, NO_SCOPE)
    expect(refused.ok).toBe(false)
    // A deny from the same device is harmless and goes through.
    expect(b.respond('t1', opened().requestId, 'deny', {}, NO_SCOPE)).toEqual({ ok: true })
    await expect(answer).resolves.toEqual({ decision: 'deny', reason: 'user' })
  })

  it('lets a phone with the chat scope approve a host write as drafted', async () => {
    const { b, opened } = broker()
    const answer = b.ask({ threadId: 't1', toolName: 'x', detail: 'd', hostWrite: card })
    const shown = hostWriteShownDigest(opened().requestId, card)!
    expect(b.respond('t1', opened().requestId, 'approve', { resolve: true, shown }, PHONE)).toEqual({ ok: true })
    await expect(answer).resolves.toEqual({ decision: 'approve', response: { resolve: true, shown } })
  })

  it('refuses a phone approval without the digest of this draft, keeps the card open, and still takes a deny', async () => {
    const { b, opened } = broker()
    const answer = b.ask({ threadId: 't1', toolName: 'x', detail: 'd', hostWrite: card })
    const id = opened().requestId
    // An app built before the digest showed a shortened card and sends none.
    expect(b.respond('t1', id, 'approve', { resolve: true }, PHONE)).toEqual({ ok: false, message: HOST_WRITE_SHOWN_REQUIRED })
    // One that rendered another draft sends a different one.
    const other = hostWriteShownDigest(id, { ...card, replyText: 'something else' })!
    expect(b.respond('t1', id, 'approve', { resolve: true, shown: other }, PHONE)).toEqual({ ok: false, message: HOST_WRITE_SHOWN_REQUIRED })
    expect(b.respond('t1', id, 'deny', {}, PHONE)).toEqual({ ok: true })
    await expect(answer).resolves.toEqual({ decision: 'deny', reason: 'user' })
  })

  it('refuses the digest of the same text on another card or another pull request', async () => {
    const { b, events } = broker()
    const first = b.ask({ threadId: 't1', toolName: 'x', detail: 'd', hostWrite: card })
    const otherPr: HostWriteCard = { ...card, prLabel: 'repo #2', target: { repository: 'acme/repo', number: 2 } }
    void b.ask({ threadId: 't1', toolName: 'x', detail: 'd', hostWrite: otherPr })
    const [a, c] = events.filter((e) => e.type === 'request.opened') as Array<Extract<RuntimeEvent, { type: 'request.opened' }>>
    // The phone approved card A's draft; the digest must not approve card B, same text or not.
    expect(b.respond('t1', c.requestId, 'approve', { resolve: true, shown: hostWriteShownDigest(a.requestId, card)! }, PHONE))
      .toEqual({ ok: false, message: HOST_WRITE_SHOWN_REQUIRED })
    expect(b.respond('t1', c.requestId, 'approve', { resolve: true, shown: hostWriteShownDigest(c.requestId, card)! }, PHONE))
      .toEqual({ ok: false, message: HOST_WRITE_SHOWN_REQUIRED })
    expect(b.respond('t1', c.requestId, 'approve', { resolve: true, shown: hostWriteShownDigest(c.requestId, otherPr)! }, PHONE)).toEqual({ ok: true })
    expect(b.respond('t1', a.requestId, 'deny', {}, PHONE)).toEqual({ ok: true })
    await expect(first).resolves.toMatchObject({ decision: 'deny' })
  })

  it('needs no digest from the desktop', async () => {
    const { b, opened } = broker()
    const answer = b.ask({ threadId: 't1', toolName: 'x', detail: 'd', hostWrite: card })
    expect(b.respond('t1', opened().requestId, 'approve', { resolve: false }, DESKTOP)).toEqual({ ok: true })
    await expect(answer).resolves.toMatchObject({ decision: 'approve' })
  })

  it('refuses a review approved without a verdict, or with one the card did not offer, and keeps it open', async () => {
    const { b, opened } = broker()
    const answer = b.ask({ threadId: 't1', toolName: 'x', detail: 'd', hostWrite: reviewCard })
    const id = opened().requestId
    const shown = hostWriteShownDigest(id, reviewCard)!
    expect(b.respond('t1', id, 'approve', { shown }, PHONE)).toEqual({ ok: false, message: expect.stringContaining('Pick Comment') })
    expect(b.respond('t1', id, 'approve', { verdict: 'approve', shown }, PHONE)).toEqual({ ok: false, message: 'Approve is not offered on this review.' })
    expect(b.respond('t1', id, 'approve', { verdict: 'comment', shown }, PHONE)).toEqual({ ok: true })
    await expect(answer).resolves.toEqual({ decision: 'approve', response: { verdict: 'comment', shown } })
  })

  it('lets any device approve an ordinary card', async () => {
    const { b, opened } = broker()
    const answer = b.ask({ threadId: 't1', toolName: 'mcp__switchboard__send_agent_message', detail: 'd' })
    expect(b.respond('t1', opened().requestId, 'approve', {}, NO_SCOPE)).toEqual({ ok: true })
    await expect(answer).resolves.toMatchObject({ decision: 'approve' })
  })

  it('accepts the answer under a rotated id of the same chat, not another chat', async () => {
    const { b, opened } = broker()
    const answer = b.ask({ threadId: 't1', toolName: 'x', detail: 'd' })
    expect(b.respond('t2', opened().requestId, 'approve', {}, DESKTOP).ok).toBe(false)
    expect(b.respond('rotated-t1', opened().requestId, 'approve', {}, DESKTOP).ok).toBe(true)
    await answer
  })

  it('denies an unanswered card when it expires', async () => {
    vi.useFakeTimers()
    const { b, events } = broker(1_000)
    const answer = b.ask({ threadId: 't1', toolName: 'x', detail: 'd', hostWrite: card })
    vi.advanceTimersByTime(1_000)
    await expect(answer).resolves.toEqual({ decision: 'deny', reason: 'expired' })
    expect(events.at(-1)).toMatchObject({ type: 'request.closed', decision: 'deny' })
  })

  it('closes the card when the agent cancels the call, so a late approval cannot post', async () => {
    const { b, opened } = broker()
    const controller = new AbortController()
    const answer = b.ask({ threadId: 't1', toolName: 'x', detail: 'd', hostWrite: card, signal: controller.signal })
    const id = opened().requestId
    controller.abort()
    await expect(answer).resolves.toEqual({ decision: 'deny', reason: 'cancelled' })
    expect(b.respond('t1', id, 'approve', {}, DESKTOP).ok).toBe(false)
  })

  it('closes every card of a stopped session and no other', async () => {
    const { b } = broker()
    const one = b.ask({ threadId: 't1', toolName: 'x', detail: 'd' })
    const two = b.ask({ threadId: 't2', toolName: 'x', detail: 'd' })
    b.closeThread('t1')
    await expect(one).resolves.toEqual({ decision: 'deny', reason: 'stopped' })
    let settled = false
    void two.then(() => { settled = true })
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    b.closeAll()
    await two
  })
})

describe('AgentWriteBudget', () => {
  it('refuses the write past the limit inside the window, and frees up after it', () => {
    let now = 0
    const budget = new AgentWriteBudget(2, 60_000, () => now)
    expect(budget.take('chat').ok).toBe(true)
    expect(budget.take('chat').ok).toBe(true)
    const refused = budget.take('chat')
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.message).toContain('Nothing was sent')
    expect(budget.take('other').ok).toBe(true)
    now = 60_000
    expect(budget.take('chat').ok).toBe(true)
  })
})
