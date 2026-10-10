import { describe, expect, it } from 'vitest'
import { AgentApprovalBroker, type AgentApprovalCard } from '../../src/main/mcp/agent-approvals'
import { AgentWriteBudget } from '../../src/main/mcp/agent-write-budget'
import type { RuntimeEvent } from '../../src/shared/provider-events'
import type { HostWriteCard, HostWriteResponse } from '../../src/shared/agent-host-writes'
import { HOST_WRITE_SHOWN_REQUIRED, hostWriteShownDigest } from '../../src/shared/host-write-phone'
import {
  memoryApprovalCardStore,
  type ApprovalCardClose,
  type ApprovalCardStore,
} from '../../src/shared/agent-approval-cards'
import type { AgentWritePlan } from '../../src/main/mcp/agent-approvals'

const card: HostWriteCard = {
  action: 'reply',
  agentLabel: 'Codex',
  host: 'github',
  prLabel: 'repo #1',
  target: { repository: 'acme/repo', number: 1 },
  url: null,
  location: 'a.ts:1',
  quote: null,
  replyText: 'done',
  maxChars: 8000,
}

const DESKTOP = { mayApproveHostWrite: true, label: 'the desktop' }
const NO_SCOPE = { mayApproveHostWrite: false, label: 'device session d0' }
const PHONE = { mayApproveHostWrite: true, mustProveShown: true, label: 'device session d1' }

const reviewCard: HostWriteCard = {
  ...card,
  action: 'review',
  location: null,
  replyText: undefined,
  review: { summary: 'Two notes.', comments: [], verdicts: ['comment'], commentOnly: 'author' },
}

const PLAN: AgentWritePlan = { kind: 'peer-send', sessionId: 's2', message: 'hi' }

interface Closed {
  close: ApprovalCardClose
  response: HostWriteResponse
}

function broker(store: ApprovalCardStore<AgentWritePlan> = memoryApprovalCardStore()) {
  const events: RuntimeEvent[] = []
  const closes = new Map<string, (closed: Closed) => void>()
  const closed: Array<{ card: AgentApprovalCard } & Closed> = []
  const b = new AgentApprovalBroker({
    publish: (e) => events.push(e),
    // Rotated ids share a root: 'rotated-t1' is chat 't1'.
    sameChat: (a, c) => a.replace('rotated-', '') === c.replace('rotated-', ''),
    store,
    onClosed: (c, close, response) => {
      closed.push({ card: c, close, response })
      closes.get(c.requestId)?.({ close, response })
    },
  })
  const opened = () =>
    events.find((e) => e.type === 'request.opened') as Extract<RuntimeEvent, { type: 'request.opened' }>
  return { b, events, opened, closes, closed }
}

/** Open a card on `threadId` (its chat is the same id) and resolve once it closes. */
function ask(b: AgentApprovalBroker, threadId: string, hostWrite?: HostWriteCard): Promise<Closed> {
  const handle = brokers.get(b)!
  const opened = b.open({
    threadId,
    chatId: threadId,
    toolName: 'x',
    detail: 'd',
    ...(hostWrite ? { hostWrite } : {}),
    plan: PLAN,
  })
  if (!opened.ok) throw new Error(opened.message)
  return new Promise((resolve) => handle.set(opened.requestId, resolve))
}

const brokers = new Map<AgentApprovalBroker, Map<string, (closed: Closed) => void>>()
function tracked(store?: ApprovalCardStore<AgentWritePlan>) {
  const made = broker(store)
  brokers.set(made.b, made.closes)
  return made
}

describe('AgentApprovalBroker', () => {
  it('opens a card on the chat and returns the approval with the edited text', async () => {
    const { b, events, opened } = tracked()
    const answer = ask(b, 't1', card)
    expect(opened()).toMatchObject({ threadId: 't1', requestType: 'tool', hostWrite: card })
    expect(AgentApprovalBroker.owns(opened().requestId)).toBe(true)
    expect(b.respond('t1', opened().requestId, 'approve', { text: 'edited', resolve: true }, DESKTOP)).toEqual({
      ok: true,
    })
    await expect(answer).resolves.toEqual({
      close: { kind: 'approve', wake: true },
      response: { text: 'edited', resolve: true },
    })
    expect(events.at(-1)).toEqual({
      type: 'request.closed',
      threadId: 't1',
      requestId: opened().requestId,
      decision: 'approve',
    })
  })

  it('refuses a host write approval from a device that cannot write to a host, and keeps the card open', async () => {
    const { b, opened } = tracked()
    const answer = ask(b, 't1', card)
    const refused = b.respond('t1', opened().requestId, 'approve', {}, NO_SCOPE)
    expect(refused.ok).toBe(false)
    // A deny from the same device is harmless and goes through.
    expect(b.respond('t1', opened().requestId, 'deny', {}, NO_SCOPE)).toEqual({ ok: true })
    await expect(answer).resolves.toEqual({ close: { kind: 'deny', wake: true }, response: {} })
  })

  it('lets a phone with the chat scope approve a host write as drafted', async () => {
    const { b, opened } = tracked()
    const answer = ask(b, 't1', card)
    const shown = hostWriteShownDigest(opened().requestId, card)!
    expect(b.respond('t1', opened().requestId, 'approve', { resolve: true, shown }, PHONE)).toEqual({ ok: true })
    await expect(answer).resolves.toEqual({
      close: { kind: 'approve', wake: true },
      response: { resolve: true, shown },
    })
  })

  it('refuses a phone approval without the digest of this draft, keeps the card open, and still takes a deny', async () => {
    const { b, opened } = tracked()
    const answer = ask(b, 't1', card)
    const id = opened().requestId
    // An app built before the digest showed a shortened card and sends none.
    expect(b.respond('t1', id, 'approve', { resolve: true }, PHONE)).toEqual({
      ok: false,
      message: HOST_WRITE_SHOWN_REQUIRED,
    })
    // One that rendered another draft sends a different one.
    const other = hostWriteShownDigest(id, { ...card, replyText: 'something else' })!
    expect(b.respond('t1', id, 'approve', { resolve: true, shown: other }, PHONE)).toEqual({
      ok: false,
      message: HOST_WRITE_SHOWN_REQUIRED,
    })
    expect(b.respond('t1', id, 'deny', {}, PHONE)).toEqual({ ok: true })
    await expect(answer).resolves.toEqual({ close: { kind: 'deny', wake: true }, response: {} })
  })

  it('refuses the digest of the same text on another card or another pull request', async () => {
    const { b, events } = tracked()
    const first = ask(b, 't1', card)
    const otherPr: HostWriteCard = { ...card, prLabel: 'repo #2', target: { repository: 'acme/repo', number: 2 } }
    void ask(b, 't1', otherPr)
    const [a, c] = events.filter((e) => e.type === 'request.opened') as Array<
      Extract<RuntimeEvent, { type: 'request.opened' }>
    >
    // The phone approved card A's draft; the digest must not approve card B, same text or not.
    expect(
      b.respond(
        't1',
        c.requestId,
        'approve',
        { resolve: true, shown: hostWriteShownDigest(a.requestId, card)! },
        PHONE,
      ),
    ).toEqual({ ok: false, message: HOST_WRITE_SHOWN_REQUIRED })
    expect(
      b.respond(
        't1',
        c.requestId,
        'approve',
        { resolve: true, shown: hostWriteShownDigest(c.requestId, card)! },
        PHONE,
      ),
    ).toEqual({ ok: false, message: HOST_WRITE_SHOWN_REQUIRED })
    expect(
      b.respond(
        't1',
        c.requestId,
        'approve',
        { resolve: true, shown: hostWriteShownDigest(c.requestId, otherPr)! },
        PHONE,
      ),
    ).toEqual({ ok: true })
    expect(b.respond('t1', a.requestId, 'deny', {}, PHONE)).toEqual({ ok: true })
    await expect(first).resolves.toMatchObject({ close: { kind: 'deny' } })
  })

  it('refuses a review the host would not take before closing the card, so the user can pick again', async () => {
    const { b, opened } = tracked()
    const silent: HostWriteCard = {
      ...card,
      action: 'review',
      location: null,
      replyText: undefined,
      host: 'github',
      review: { summary: '', comments: [], verdicts: ['comment', 'request_changes'] },
    }
    const answer = ask(b, 't1', silent)
    const id = opened().requestId
    const shown = hostWriteShownDigest(id, silent)!
    // GitHub needs a summary to request changes; the card stays open.
    expect(b.respond('t1', id, 'approve', { verdict: 'request_changes', shown }, PHONE)).toEqual({
      ok: false,
      message: expect.stringContaining('GitHub needs a summary'),
    })
    expect(b.respond('t1', id, 'approve', { verdict: 'comment', shown }, PHONE)).toEqual({
      ok: false,
      message: expect.stringContaining('Write a summary'),
    })
    expect(b.respond('t1', id, 'deny', {}, PHONE)).toEqual({ ok: true })
    await expect(answer).resolves.toMatchObject({ close: { kind: 'deny' } })
  })

  it('needs no digest from the desktop', async () => {
    const { b, opened } = tracked()
    const answer = ask(b, 't1', card)
    expect(b.respond('t1', opened().requestId, 'approve', { resolve: false }, DESKTOP)).toEqual({ ok: true })
    await expect(answer).resolves.toMatchObject({ close: { kind: 'approve' } })
  })

  it('refuses a review approved without a verdict, or with one the card did not offer, and keeps it open', async () => {
    const { b, opened } = tracked()
    const answer = ask(b, 't1', reviewCard)
    const id = opened().requestId
    const shown = hostWriteShownDigest(id, reviewCard)!
    expect(b.respond('t1', id, 'approve', { shown }, PHONE)).toEqual({
      ok: false,
      message: expect.stringContaining('Pick Comment'),
    })
    expect(b.respond('t1', id, 'approve', { verdict: 'approve', shown }, PHONE)).toEqual({
      ok: false,
      message: 'Approve is not offered on this review.',
    })
    expect(b.respond('t1', id, 'approve', { verdict: 'comment', shown }, PHONE)).toEqual({ ok: true })
    await expect(answer).resolves.toEqual({
      close: { kind: 'approve', wake: true },
      response: { verdict: 'comment', shown },
    })
  })

  it('lets any device approve an ordinary card', async () => {
    const { b, opened } = tracked()
    const answer = ask(b, 't1')
    expect(b.respond('t1', opened().requestId, 'approve', {}, NO_SCOPE)).toEqual({ ok: true })
    await expect(answer).resolves.toMatchObject({ close: { kind: 'approve' } })
  })

  it('accepts the answer under a rotated id of the same chat, not another chat', async () => {
    const { b, opened } = tracked()
    const answer = ask(b, 't1')
    expect(b.respond('t2', opened().requestId, 'approve', {}, DESKTOP).ok).toBe(false)
    expect(b.respond('rotated-t1', opened().requestId, 'approve', {}, DESKTOP).ok).toBe(true)
    await answer
  })
})

describe('a card that does not hold the turn', () => {
  it('approves quietly and dismisses: the write runs or not, and the agent is not woken', async () => {
    const { b, events } = tracked()
    const quiet = ask(b, 't1', card)
    const id = (events.at(-1) as Extract<RuntimeEvent, { type: 'request.opened' }>).requestId
    expect(b.respond('t1', id, 'approve', { resolve: false, quiet: true }, DESKTOP)).toEqual({ ok: true })
    await expect(quiet).resolves.toEqual({
      close: { kind: 'approve', wake: false },
      response: { resolve: false, quiet: true },
    })
    const dismissed = ask(b, 't1', card)
    const second = (events.at(-1) as Extract<RuntimeEvent, { type: 'request.opened' }>).requestId
    expect(b.respond('t1', second, 'deny', { quiet: true }, DESKTOP)).toEqual({ ok: true })
    await expect(dismissed).resolves.toEqual({ close: { kind: 'deny', wake: false }, response: { quiet: true } })
  })

  it('closes exactly once: a second answer, from any client, is refused', async () => {
    const { b, opened, closed } = tracked()
    void ask(b, 't1')
    const id = opened().requestId
    expect(b.respond('t1', id, 'approve', {}, DESKTOP)).toEqual({ ok: true })
    expect(b.respond('t1', id, 'deny', {}, PHONE)).toEqual({ ok: false, message: 'That request is no longer open.' })
    expect(b.withdraw('t1', id).ok).toBe(false)
    expect(closed).toHaveLength(1)
  })

  it('lets the agent withdraw only a card of its own chat', async () => {
    const { b, opened, events } = tracked()
    const answer = ask(b, 't1')
    const id = opened().requestId
    expect(b.withdraw('t2', id)).toEqual({ ok: false, message: `No open approval card ${id} in this chat.` })
    expect(b.withdraw('t1', id)).toEqual({ ok: true })
    await expect(answer).resolves.toEqual({ close: { kind: 'withdrawn' }, response: {} })
    expect(events.at(-1)).toEqual({ type: 'request.closed', threadId: 't1', requestId: id, decision: 'deny' })
  })

  it('closes every card of a stopped chat and no other', async () => {
    const { b, closed } = tracked()
    const one = ask(b, 't1')
    void ask(b, 't2')
    b.closeChat('t1')
    await expect(one).resolves.toEqual({ close: { kind: 'stopped' }, response: {} })
    expect(closed.map((c) => c.card.chatId)).toEqual(['t1'])
    expect(b.pendingEvents('t2')).toHaveLength(1)
  })

  it('caps the open cards of one chat, and frees a slot when one closes', () => {
    const { b } = tracked()
    for (let i = 0; i < 20; i++) b.open({ threadId: 't1', chatId: 't1', toolName: 'x', detail: 'd', plan: PLAN })
    const refused = b.open({ threadId: 't1', chatId: 't1', toolName: 'x', detail: 'd', plan: PLAN })
    expect(refused).toEqual({ ok: false, message: expect.stringContaining('20 approval cards waiting') })
    expect(b.openProblem('t1')).not.toBeNull()
    expect(b.open({ threadId: 't2', chatId: 't2', toolName: 'x', detail: 'd', plan: PLAN }).ok).toBe(true)
    b.withdraw('t1', b.pendingEvents('t1')[0].requestId)
    expect(b.openProblem('t1')).toBeNull()
  })

  it('keeps an open card across a restart, recovers it for clients, and still runs it once answered', async () => {
    const store = memoryApprovalCardStore<AgentWritePlan>()
    const before = tracked(store)
    const opened = before.b.open({
      threadId: 't1',
      chatId: 't1',
      toolName: 'x',
      detail: 'd',
      hostWrite: card,
      plan: PLAN,
    })
    if (!opened.ok) throw new Error(opened.message)
    // The process exits; nothing answered the card.
    const after = tracked(store)
    expect(after.b.pendingEvents('t1')).toEqual([
      {
        type: 'request.opened',
        threadId: 't1',
        requestId: opened.requestId,
        requestType: 'tool',
        toolName: 'x',
        detail: 'd',
        hostWrite: card,
      },
    ])
    // A phone that recovered it hours later still proves what it showed.
    const shown = hostWriteShownDigest(opened.requestId, card)!
    expect(after.b.respond('rotated-t1', opened.requestId, 'approve', { resolve: true, shown }, PHONE)).toEqual({
      ok: true,
    })
    expect(after.closed).toEqual([
      {
        card: expect.objectContaining({ requestId: opened.requestId, plan: PLAN }),
        close: { kind: 'approve', wake: true },
        response: { resolve: true, shown },
      },
    ])
    // Closed on the id it opened on and on the id the answering client knows it by.
    expect(after.events.filter((e) => e.type === 'request.closed').map((e) => e.threadId)).toEqual(['t1', 'rotated-t1'])
    expect(tracked(store).b.pendingEvents('t1')).toEqual([])
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
