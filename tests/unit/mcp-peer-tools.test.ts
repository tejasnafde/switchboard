/**
 * The cross-session tools on the Switchboard MCP server keep the gate Claude's
 * canUseTool used to apply, now for all three agents: listing runs unasked,
 * a send is denied in plan, sent in full access and carded otherwise. A card
 * does not hold the call: the tool says it is queued, and the approval sends.
 */
import { describe, expect, it, vi } from 'vitest'
import { until } from './helpers/wait'
import { AgentApprovalBroker } from '../../src/main/mcp/agent-approvals'
import { buildPeerMcpTools, runPeerSendPlan, type PeerSendPlan } from '../../src/main/mcp/peer-mcp-tools'
import type { McpTool } from '../../src/main/mcp/mcp-session'
import type { PeerToolHost } from '../../src/main/provider/peer-tools'
import type { PeerMessageInput } from '../../src/shared/peer-messaging'
import type { RuntimeEvent, RuntimeMode } from '../../src/shared/provider-events'

function setup(mode: RuntimeMode, decision?: 'approve' | 'deny', linked = false, lineage = false, hubChildren = false) {
  const events: RuntimeEvent[] = []
  const delivered: PeerMessageInput[] = []
  const sends: Array<Promise<unknown>> = []
  const peers: PeerToolHost = {
    listPeerSessions: vi.fn(() => [
      { sessionId: 's2', title: 'Other', folder: '/p', provider: 'codex' as const, midTurn: false, linked },
    ]),
    isLinkedPeer: vi.fn(() => linked || lineage),
    isLineagePeer: vi.fn(() => lineage),
    deliverPeerMessage: vi.fn(async (input: PeerMessageInput) => {
      delivered.push(input)
      return { id: 'pm_0123456789abcdef' }
    }),
  }
  const approvals = new AgentApprovalBroker({
    publish: (e) => {
      events.push(e)
      if (e.type === 'request.opened' && decision)
        queueMicrotask(() =>
          approvals.respond('t1', e.requestId, decision, {}, { mayApproveHostWrite: false, label: 'test' }),
        )
    },
    onClosed: (card, close) => {
      if (close.kind === 'approve')
        sends.push(
          runPeerSendPlan(
            { threadId: 't1', runtimeMode: () => mode, publish: (e) => events.push(e), peers },
            card.plan as PeerSendPlan,
          ),
        )
    },
  })
  const [list, rawSend] = buildPeerMcpTools({
    threadId: 't1',
    chatId: 'root-1',
    runtimeMode: () => mode,
    publish: (e) => events.push(e),
    approvals,
    peers,
    hubChildren,
  })
  const signal = new AbortController().signal
  /** The tool, then waits for a card answered as it opened to close and run its send. */
  const send: McpTool = {
    ...rawSend,
    call: async (args, ctx) => {
      const before = events.length
      const r = await rawSend.call(args, ctx)
      const mine = () => events.slice(before).map((e) => e.type)
      if (decision && mine().includes('request.opened')) {
        await until(() => expect(mine()).toContain('request.closed'))
        await Promise.all(sends)
      }
      return r
    },
  }
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
    expect(delivered).toEqual([
      { fromThreadId: 't1', targetThreadId: 's2', text: 'the migration landed', initiator: 'agent' },
    ])
  })

  it('asks first in sandbox and accept-edits, and sends once approved (a phone may approve this one)', async () => {
    for (const mode of ['sandbox', 'accept-edits'] as const) {
      const { send, events, delivered, signal } = setup(mode, 'approve')
      await send.call(args, { signal })
      expect(events.find((e) => e.type === 'request.opened')).toMatchObject({
        toolName: 'mcp__switchboard__send_agent_message',
      })
      expect(delivered).toHaveLength(1)
    }
  })

  it('sends nothing when the chat switched to plan mode while the card was open', async () => {
    let mode: RuntimeMode = 'sandbox'
    const events: RuntimeEvent[] = []
    const delivered: PeerMessageInput[] = []
    const peers: PeerToolHost = {
      listPeerSessions: vi.fn(() => []),
      isLinkedPeer: vi.fn(() => false),
      deliverPeerMessage: vi.fn(async (input: PeerMessageInput) => {
        delivered.push(input)
        return { id: 'pm_0123456789abcdef' }
      }),
    }
    const results: Array<Promise<{ isError?: boolean }>> = []
    const approvals = new AgentApprovalBroker({
      publish: (e) => {
        events.push(e)
        if (e.type === 'request.opened') {
          mode = 'plan'
          queueMicrotask(() =>
            approvals.respond('t1', e.requestId, 'approve', {}, { mayApproveHostWrite: false, label: 'test' }),
          )
        }
      },
      onClosed: (card) => {
        results.push(
          runPeerSendPlan(
            { threadId: 't1', runtimeMode: () => mode, publish: (e) => events.push(e), peers },
            card.plan as PeerSendPlan,
          ),
        )
      },
    })
    const [, send] = buildPeerMcpTools({
      threadId: 't1',
      chatId: 'root-1',
      runtimeMode: () => mode,
      publish: (e) => events.push(e),
      approvals,
      peers,
    })
    await send.call(args, { signal: new AbortController().signal })
    await until(() => expect(results).toHaveLength(1))
    expect((await results[0]).isError).toBe(true)
    expect(delivered).toEqual([])
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.denied', mode: 'plan' }))
  })

  it('answers at once that the message is queued, and sends nothing when the user denies', async () => {
    const { send, delivered, events, signal } = setup('sandbox', 'deny')
    const result = await send.call(args, { signal })
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toMatch(/^Queued for the user's approval \(card sbmcp_/)
    expect(events.map((e) => e.type)).toEqual(['request.opened', 'request.closed'])
    expect(delivered).toEqual([])
  })

  it('refuses an empty message before it costs the user a card', async () => {
    const { send, events, signal } = setup('sandbox', 'approve')
    expect((await send.call({ sessionId: 's2', message: '  ' }, { signal })).isError).toBe(true)
    expect(events).toEqual([])
  })
})

// A link is consent to the conversation. In auto the user already lets the
// agent settle routine calls, so a card per message would undo the link;
// sandbox and accept-edits still review every send.
describe('send_agent_message along a session link', () => {
  it('sends without a card in auto mode when the target is linked', async () => {
    const { send, events, delivered, signal } = setup('auto', undefined, true)
    const result = await send.call(args, { signal })
    expect(result.isError).toBeFalsy()
    expect(events).toEqual([])
    // Delivery re-checks the link, so an unlink in flight cannot pass uncarded.
    expect(delivered).toEqual([
      { fromThreadId: 't1', targetThreadId: 's2', text: 'the migration landed', initiator: 'agent', requireLink: true },
    ])
  })

  it('still asks in auto mode when the target is not linked', async () => {
    const { send, events, delivered, signal } = setup('auto', 'approve', false)
    await send.call(args, { signal })
    expect(events.map((e) => e.type)).toContain('request.opened')
    expect(delivered).toHaveLength(1)
  })

  it('still asks in sandbox and accept-edits when linked', async () => {
    for (const mode of ['sandbox', 'accept-edits'] as const) {
      const { send, events, signal } = setup(mode, 'approve', true)
      await send.call(args, { signal })
      expect(events.map((e) => e.type)).toContain('request.opened')
    }
  })

  it('is still denied in plan mode when linked', async () => {
    const { send, delivered, signal } = setup('plan', undefined, true)
    expect((await send.call(args, { signal })).isError).toBe(true)
    expect(delivered).toEqual([])
  })

  // No tool can create or extend a link: the server offers the two session tools and nothing else.
  it('offers the agent no way to link', () => {
    const { list, send } = setup('full-access')
    const tools = buildPeerMcpTools({
      threadId: 't1',
      chatId: 'root-1',
      runtimeMode: () => 'full-access',
      publish: () => {},
      approvals: { open: vi.fn() },
      peers: setup('full-access').peers,
      hubChildren: false,
    })
    expect(tools.map((t) => t.name)).toEqual([list.name, send.name])
    expect(tools.map((t) => t.name)).toEqual(['list_agent_sessions', 'send_agent_message'])
  })
})

// A parent and its child chat share a lineage edge, made by the batch the user approved.
describe('send_agent_message between a parent and its child chat', () => {
  it('sends without a card in every mode but plan, queued by default', async () => {
    for (const mode of ['sandbox', 'accept-edits', 'auto', 'full-access'] as const) {
      const { send, events, delivered, signal } = setup(mode, undefined, false, true, true)
      expect((await send.call(args, { signal })).isError).toBeFalsy()
      expect(events).toEqual([])
      expect(delivered).toEqual([
        {
          fromThreadId: 't1',
          targetThreadId: 's2',
          text: 'the migration landed',
          initiator: 'agent',
          delivery: 'queue',
          ...(mode === 'full-access' ? {} : { requireLink: true }),
        },
      ])
    }
  })

  it('passes steer on when asked', async () => {
    const { send, delivered, signal } = setup('auto', undefined, false, true, true)
    await send.call({ ...args, delivery: 'steer' }, { signal })
    expect(delivered[0].delivery).toBe('steer')
  })

  it('is denied in plan mode', async () => {
    const { send, delivered, signal } = setup('plan', undefined, false, true, true)
    expect((await send.call(args, { signal })).isError).toBe(true)
    expect(delivered).toEqual([])
  })

  it('keeps the card and the old schema with child chats off', async () => {
    const { send, events, delivered, signal } = setup('sandbox', 'approve', false, true, false)
    expect(Object.keys(send.inputSchema.properties as object)).toEqual(['sessionId', 'message'])
    await send.call(args, { signal })
    expect(events.map((e) => e.type)).toContain('request.opened')
    expect(delivered[0].delivery).toBeUndefined()
  })

  it('stores the delivery on a card, so the approved send keeps it', async () => {
    const { send, delivered, signal } = setup('sandbox', 'approve', false, false, true)
    await send.call({ ...args, delivery: 'steer' }, { signal })
    expect(delivered[0].delivery).toBe('steer')
  })
})
