/**
 * The cross-session tools on the Switchboard MCP server keep the gate Claude's
 * canUseTool used to apply, now for all three agents: listing runs unasked,
 * a send is denied in plan, sent in full access and carded otherwise.
 */
import { describe, expect, it, vi } from 'vitest'
import { AgentApprovalBroker } from '../../src/main/mcp/agent-approvals'
import { buildPeerMcpTools } from '../../src/main/mcp/peer-mcp-tools'
import type { PeerToolHost } from '../../src/main/provider/peer-tools'
import type { PeerMessageInput } from '../../src/shared/peer-messaging'
import type { RuntimeEvent, RuntimeMode } from '../../src/shared/provider-events'

function setup(mode: RuntimeMode, decision?: 'approve' | 'deny') {
  const events: RuntimeEvent[] = []
  const delivered: PeerMessageInput[] = []
  const peers: PeerToolHost = {
    listPeerSessions: vi.fn(() => [{ sessionId: 's2', title: 'Other', folder: '/p', provider: 'codex' as const, midTurn: false }]),
    deliverPeerMessage: vi.fn(async (input: PeerMessageInput) => { delivered.push(input); return { id: 'pm_0123456789abcdef' } }),
  }
  const approvals = new AgentApprovalBroker({
    publish: (e) => {
      events.push(e)
      if (e.type === 'request.opened' && decision) queueMicrotask(() => approvals.respond('t1', e.requestId, decision, {}, { mayApproveHostWrite: false, label: 'test' }))
    },
  })
  const [list, send] = buildPeerMcpTools({ threadId: 't1', runtimeMode: () => mode, publish: (e) => events.push(e), approvals, peers })
  const signal = new AbortController().signal
  return { list, send, events, delivered, peers, signal }
}

const args = { sessionId: 's2', message: 'the migration landed' }

describe('list_agent_sessions', () => {
  it('is read-only and runs without a card, even in plan mode', async () => {
    const { list, events, peers, signal } = setup('plan')
    expect(list.annotations.readOnlyHint).toBe(true)
    const result = await list.call({}, { signal })
    expect(result.content[0].text).toContain('s2')
    expect(peers.listPeerSessions).toHaveBeenCalledWith('t1')
    expect(events).toEqual([])
  })
})

describe('send_agent_message', () => {
  it('is denied in plan mode, with the denial pill and no card', async () => {
    const { send, events, delivered, signal } = setup('plan')
    const result = await send.call(args, { signal })
    expect(result.isError).toBe(true)
    expect(events.map((e) => e.type)).toEqual(['tool.denied'])
    expect(delivered).toEqual([])
  })

  it('sends unattended in full access', async () => {
    const { send, events, delivered, signal } = setup('full-access')
    await send.call(args, { signal })
    expect(events).toEqual([])
    expect(delivered).toEqual([{ fromThreadId: 't1', targetThreadId: 's2', text: 'the migration landed', initiator: 'agent' }])
  })

  it('asks first in sandbox and accept-edits, and sends once approved (a phone may approve this one)', async () => {
    for (const mode of ['sandbox', 'accept-edits'] as const) {
      const { send, events, delivered, signal } = setup(mode, 'approve')
      await send.call(args, { signal })
      expect(events.find((e) => e.type === 'request.opened')).toMatchObject({ toolName: 'mcp__switchboard__send_agent_message' })
      expect(delivered).toHaveLength(1)
    }
  })

  it('sends nothing when the chat switched to plan mode while the card was open', async () => {
    let mode: RuntimeMode = 'sandbox'
    const events: RuntimeEvent[] = []
    const delivered: PeerMessageInput[] = []
    const peers: PeerToolHost = {
      listPeerSessions: vi.fn(() => []),
      deliverPeerMessage: vi.fn(async (input: PeerMessageInput) => { delivered.push(input); return { id: 'pm_0123456789abcdef' } }),
    }
    const approvals = new AgentApprovalBroker({
      publish: (e) => {
        events.push(e)
        if (e.type === 'request.opened') {
          mode = 'plan'
          queueMicrotask(() => approvals.respond('t1', e.requestId, 'approve', {}, { mayApproveHostWrite: false, label: 'test' }))
        }
      },
    })
    const [, send] = buildPeerMcpTools({ threadId: 't1', runtimeMode: () => mode, publish: (e) => events.push(e), approvals, peers })
    const result = await send.call(args, { signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(delivered).toEqual([])
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.denied', mode: 'plan' }))
  })

  it('sends nothing when the user denies', async () => {
    const { send, delivered, signal } = setup('sandbox', 'deny')
    const result = await send.call(args, { signal })
    expect(result.isError).toBe(true)
    expect(delivered).toEqual([])
  })
})
