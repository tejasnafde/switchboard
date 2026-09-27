import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentApprovalBroker } from '../../src/main/mcp/agent-approvals'
import { AgentWriteBudget } from '../../src/main/mcp/agent-write-budget'
import type { RuntimeEvent } from '../../src/shared/provider-events'
import type { HostWriteCard } from '../../src/shared/agent-host-writes'

const card: HostWriteCard = {
  action: 'reply', agentLabel: 'Codex', host: 'github', prLabel: 'repo #1', url: null,
  location: 'a.ts:1', quote: null, replyText: 'done', maxChars: 8000,
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
    expect(b.respond('t1', opened().requestId, 'approve', { text: 'edited', resolve: true }, true)).toEqual({ ok: true })
    await expect(answer).resolves.toEqual({ decision: 'approve', response: { text: 'edited', resolve: true } })
    expect(events.at(-1)).toEqual({ type: 'request.closed', threadId: 't1', requestId: opened().requestId, decision: 'approve' })
  })

  it('refuses a host write approval from a device that cannot write to a host, and keeps the card open', async () => {
    const { b, opened } = broker()
    const answer = b.ask({ threadId: 't1', toolName: 'x', detail: 'd', hostWrite: card })
    const refused = b.respond('t1', opened().requestId, 'approve', {}, false)
    expect(refused.ok).toBe(false)
    // A deny from the same device is harmless and goes through.
    expect(b.respond('t1', opened().requestId, 'deny', {}, false)).toEqual({ ok: true })
    await expect(answer).resolves.toEqual({ decision: 'deny', reason: 'user' })
  })

  it('lets any device approve an ordinary card', async () => {
    const { b, opened } = broker()
    const answer = b.ask({ threadId: 't1', toolName: 'mcp__switchboard__send_agent_message', detail: 'd' })
    expect(b.respond('t1', opened().requestId, 'approve', {}, false)).toEqual({ ok: true })
    await expect(answer).resolves.toMatchObject({ decision: 'approve' })
  })

  it('accepts the answer under a rotated id of the same chat, not another chat', async () => {
    const { b, opened } = broker()
    const answer = b.ask({ threadId: 't1', toolName: 'x', detail: 'd' })
    expect(b.respond('t2', opened().requestId, 'approve', {}, true).ok).toBe(false)
    expect(b.respond('rotated-t1', opened().requestId, 'approve', {}, true).ok).toBe(true)
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
    expect(b.respond('t1', id, 'approve', {}, true).ok).toBe(false)
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
