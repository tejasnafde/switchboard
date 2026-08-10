/**
 * Agent-initiated peer sends against the real registry.
 *
 * The tools run in-process next to the adapter, so they call the registry
 * directly rather than over the wire; the WsHost is still here because the
 * events a client would see are half the contract. Harness and DB mocks mirror
 * peer-message-delivery-ws.test.ts, which covers the user-typed `/send-to`
 * path over the socket.
 *
 * The load-bearing assertions are the two guards that only exist for the agent
 * path: a session acting on a peer message cannot pass one on, and one session
 * cannot fan out past its own budget by opening more targets.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type AddressInfo } from 'ws'

vi.mock('../../src/main/db/providerInstances', () => ({
  resolveProviderInstance: (agentType: string, id?: string) => ({
    id: id ?? `${agentType}-default`,
    env: {},
    oauthDir: null,
  }),
  listOauthDirsForAgent: () => [],
}))

const titles = new Map<string, string>([
  ['sender', 'Docs pass'],
  ['target', 'API refactor'],
  ['second', 'Infra cleanup'],
])
const saved: Array<{ id: string; conversationId: string; role: string; content: string }> = []
vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: () => {},
  updateConversationSessionId: () => {},
  resolveRootThreadId: (id: string) => id,
  getConversationTitle: (id: string) => titles.get(id) ?? null,
  saveMessageIfAbsent: (id: string, conversationId: string, role: string, content: string) => {
    saved.push({ id, conversationId, role, content })
    return true
  },
  getConversationRuntimeMode: () => null,
  getConversationModel: () => null,
  getConversationAgentType: () => null,
  getConversationProviderInstanceId: () => null,
  getSetting: () => null,
}))

import { WsHost } from '../../src/main/backend/ws-host'
import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { WsTransport } from '../../src/shared/ws-transport'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import { createPeerToolHandlers, PEER_LIST_TOOL_NAME } from '../../src/main/provider/peer-tools'
import {
  PEER_AGENT_SEND_BUDGET,
  PEER_AGENT_SENT_MARKER_PREFIX,
  wrapPeerMessage,
} from '../../src/shared/peer-messaging'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent } from '../../src/shared/provider-events'

class RecordingAdapter implements ProviderAdapter {
  readonly provider = 'claude' as const
  readonly turns: Array<{ threadId: string; message: string }> = []
  private emit = new Map<string, (e: RuntimeEvent) => void>()

  async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    this.emit.set(opts.threadId, onEvent)
    return {
      threadId: opts.threadId,
      provider: 'claude',
      status: 'ready',
      runtimeMode: opts.runtimeMode ?? 'sandbox',
      cwd: opts.cwd,
      createdAt: 0,
    }
  }

  /** When true, no turn.completed fires, so the thread stays mid-turn. */
  hangTurn = false

  async sendTurn(threadId: string, message: string): Promise<void> {
    this.turns.push({ threadId, message })
    if (!this.hangTurn) this.emit.get(threadId)?.({ type: 'turn.completed', threadId })
  }

  async respondToRequest(): Promise<void> {}
  async interruptTurn(): Promise<void> {}
  async stopSession(threadId: string): Promise<void> {
    this.emit.delete(threadId)
  }
  async setRuntimeMode(): Promise<void> {}
  async isAvailable(): Promise<boolean> {
    return true
  }
}

let wss: WebSocketServer | null = null
let client: WsTransport | null = null
let registry: ProviderRegistry | null = null
const scratchDirs: string[] = []

async function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'sb-peer-agent-'))
  scratchDirs.push(cwd)
  wss = new WebSocketServer({ port: 0 })
  const host = new WsHost(wss)
  const adapter = new RecordingAdapter()
  registry = new ProviderRegistry(host, new Map([['claude', adapter]]))
  registry.registerIpcHandlers()
  await new Promise<void>((res) => wss!.on('listening', () => res()))
  const { port } = wss.address() as AddressInfo

  const events: RuntimeEvent[] = []
  client = new WsTransport(`ws://localhost:${port}`)
  client.on(ProviderChannels.EVENT, (e: RuntimeEvent) => events.push(e))
  saved.length = 0
  return { cwd, events, adapter, registry }
}

const flush = () => new Promise((r) => setTimeout(r, 40))

/** Every session this suite messages between, started and ready to receive. */
async function startAll(cwd: string, ids: string[] = ['sender', 'target']) {
  for (const threadId of ids) {
    await client!.invoke(ProviderChannels.START_SESSION, { threadId, provider: 'claude', cwd })
  }
}

/** The tools as the model in `from` calls them. */
const toolsFor = (from: string) => createPeerToolHandlers(registry!, from)

const text = (result: { content: Array<{ text: string }> }) =>
  result.content.map((c) => c.text).join('\n')

afterEach(async () => {
  client?.close()
  client = null
  await registry?.stopAll()
  registry = null
  await new Promise<void>((res) => (wss ? wss.close(() => res()) : res()))
  wss = null
  while (scratchDirs.length) rmSync(scratchDirs.pop()!, { recursive: true, force: true })
})

describe('list_agent_sessions against the registry', () => {
  it('lists the other live sessions and not the caller', async () => {
    const { cwd } = await setup()
    await startAll(cwd)

    const body = text(await toolsFor('sender').listSessions())
    // Parsed, not substring-matched: the payload is JSON, so a Windows cwd
    // arrives with escaped separators and a raw contains() on the path fails.
    const listed = JSON.parse(body.slice(body.indexOf('['))) as Array<{
      sessionId: string; title: string; folder: string
    }>
    expect(listed.map((s) => s.sessionId)).toEqual(['target'])
    expect(listed[0].title).toBe('API refactor')
    expect(listed[0].folder).toBe(cwd)
  })

  it('reports a session that is mid-turn', async () => {
    const { cwd, adapter } = await setup()
    await startAll(cwd)

    adapter.hangTurn = true
    await client!.invoke(ProviderChannels.SEND_TURN, 'target', 'a long running turn')
    await flush()

    expect(text(await toolsFor('sender').listSessions())).toContain('"midTurn": true')
  })
})

describe('send_agent_message against the registry', () => {
  it('reaches the target adapter as a wrapped turn', async () => {
    const { cwd, adapter } = await setup()
    await startAll(cwd)

    const out = await toolsFor('sender').sendMessage({
      sessionId: 'target',
      message: 'the auth migration landed on main',
    })

    expect(out.isError).toBeFalsy()
    expect(adapter.turns).toEqual([{
      threadId: 'target',
      message: wrapPeerMessage('Docs pass', 'the auth migration landed on main'),
    }])
  })

  // The tool has a thread id and no title, so the backend has to resolve the
  // sending label itself or the peer is told a message came from `agent_1712`.
  it('labels the sender from the conversation title', async () => {
    const { cwd, events } = await setup()
    await startAll(cwd)
    await toolsFor('sender').sendMessage({ sessionId: 'target', message: 'ready' })
    await flush()

    const received = events.find(
      (e) => e.type === 'peer.message' && 'direction' in e && e.direction === 'received',
    )
    expect(received).toMatchObject({ peerLabel: 'Docs pass', initiator: 'agent' })
  })

  // The sender's own transcript has to say the AGENT chose this, not the user.
  it('marks the sender transcript as agent-initiated', async () => {
    const { cwd } = await setup()
    await startAll(cwd)
    await toolsFor('sender').sendMessage({ sessionId: 'target', message: 'ready' })
    await flush()

    const marker = saved.find((m) => m.conversationId === 'sender' && m.role === 'system')
    expect(marker?.content).toBe(`${PEER_AGENT_SENT_MARKER_PREFIX} Docs pass → API refactor`)
  })

  it('refuses a target with no live session, in words the model can act on', async () => {
    const { cwd } = await setup()
    await startAll(cwd, ['sender'])

    const out = await toolsFor('sender').sendMessage({ sessionId: 'target', message: 'ready' })
    expect(out.isError).toBe(true)
    expect(text(out)).toMatch(/not running/i)
  })

  it('refuses a session messaging itself', async () => {
    const { cwd, adapter } = await setup()
    await startAll(cwd)

    const out = await toolsFor('sender').sendMessage({ sessionId: 'sender', message: 'note to self' })
    expect(out.isError).toBe(true)
    expect(adapter.turns).toHaveLength(0)
  })
})

describe('hop depth', () => {
  // A -> B -> A is the failure this guard exists for: it stays inside every
  // per-pair rate limit while burning tokens with nobody watching.
  it('refuses a send from a session that is acting on a peer message', async () => {
    const { cwd, adapter } = await setup()
    await startAll(cwd)

    await client!.invoke(ProviderChannels.SEND_TURN, 'sender', 'look into the auth migration')
    await flush()
    await toolsFor('sender').sendMessage({ sessionId: 'target', message: 'the migration landed' })
    await flush()
    expect(adapter.turns).toHaveLength(2)

    const back = await toolsFor('target').sendMessage({ sessionId: 'sender', message: 'thanks, and also' })
    expect(back.isError).toBe(true)
    expect(text(back)).toMatch(/acting on a message from another session/i)
    expect(adapter.turns).toHaveLength(2)
  })

  // Depth counts AGENT hops, so a message the user typed leaves the recipient
  // free to hand its own finding on.
  it('leaves a user-initiated recipient free to send', async () => {
    const { cwd, adapter } = await setup()
    await startAll(cwd, ['sender', 'target', 'second'])

    await client!.invoke(ProviderChannels.DELIVER_PEER_MESSAGE, {
      fromThreadId: 'sender',
      fromLabel: 'Docs pass',
      targetThreadId: 'target',
      text: 'have a look at the migration',
    })
    await flush()

    const on = await toolsFor('target').sendMessage({ sessionId: 'second', message: 'the schema moved' })
    expect(on.isError).toBeFalsy()
    expect(adapter.turns).toHaveLength(2)
  })
})

describe('per-sender budget', () => {
  it('caps total sends per session however many targets it opens', async () => {
    const { cwd, adapter } = await setup()
    await startAll(cwd, ['sender', 'target', 'second'])
    const tools = toolsFor('sender')

    // Split across two targets so the per-pair limit of 5 never binds - this
    // must fail on the sender's own budget, not on either pair's.
    const half = PEER_AGENT_SEND_BUDGET / 2
    for (let i = 0; i < half; i++) {
      expect((await tools.sendMessage({ sessionId: 'target', message: `note ${i}` })).isError).toBeFalsy()
      expect((await tools.sendMessage({ sessionId: 'second', message: `note ${i}` })).isError).toBeFalsy()
    }
    expect(adapter.turns).toHaveLength(PEER_AGENT_SEND_BUDGET)

    const over = await tools.sendMessage({ sessionId: 'target', message: 'one too many' })
    expect(over.isError).toBe(true)
    expect(text(over)).toMatch(/limit across all sessions/i)
    expect(adapter.turns).toHaveLength(PEER_AGENT_SEND_BUDGET)
  })

  // The user is present when they type `/send-to`, so their sends are not
  // rationed against the agent's budget.
  it('does not charge a user-initiated send against it', async () => {
    const { cwd, adapter } = await setup()
    await startAll(cwd, ['sender', 'target', 'second'])

    // A whole budget's worth of typed sends, split over two targets so the
    // per-pair limit of 5 does not bind and only the budget is under test.
    const half = PEER_AGENT_SEND_BUDGET / 2
    for (let i = 0; i < half; i++) {
      for (const targetThreadId of ['target', 'second']) {
        await client!.invoke(ProviderChannels.DELIVER_PEER_MESSAGE, {
          fromThreadId: 'sender',
          fromLabel: 'Docs pass',
          targetThreadId,
          text: `typed note ${i}`,
        })
      }
    }
    await flush()
    const out = await toolsFor('sender').sendMessage({ sessionId: 'target', message: 'and one from me' })
    expect(out.isError).toBeFalsy()
    expect(adapter.turns).toHaveLength(PEER_AGENT_SEND_BUDGET + 1)
  })
})

// One delivery path, two callers. A second copy of this logic is how the
// approval gate, the guards or the persistence would silently diverge.
describe('both entry points share one delivery method', () => {
  it('routes the IPC channel and the tool through deliverPeerMessage', async () => {
    const { cwd, registry: reg } = await setup()
    await startAll(cwd)
    const spy = vi.spyOn(reg, 'deliverPeerMessage')

    await client!.invoke(ProviderChannels.DELIVER_PEER_MESSAGE, {
      fromThreadId: 'sender',
      fromLabel: 'Docs pass',
      targetThreadId: 'target',
      text: 'typed by the user',
    })
    await toolsFor('sender').sendMessage({ sessionId: 'target', message: 'chosen by the agent' })
    await flush()

    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls[0][0]).toMatchObject({ initiator: 'user', text: 'typed by the user' })
    expect(spy.mock.calls[1][0]).toMatchObject({ initiator: 'agent', text: 'chosen by the agent' })
  })

  // A client cannot promote its own send to an agent send, which would skip
  // the approval the tool path relies on canUseTool for.
  it('ignores an initiator the client claims', async () => {
    const { cwd, registry: reg } = await setup()
    await startAll(cwd)
    const spy = vi.spyOn(reg, 'deliverPeerMessage')

    await client!.invoke(ProviderChannels.DELIVER_PEER_MESSAGE, {
      fromThreadId: 'sender',
      fromLabel: 'Docs pass',
      targetThreadId: 'target',
      text: 'claiming to be the agent',
      initiator: 'agent',
    })
    expect(spy.mock.calls[0][0]).toMatchObject({ initiator: 'user' })
  })
})

describe('tool wiring', () => {
  it('names the list tool in the refusal for a missing id', async () => {
    const { cwd } = await setup()
    await startAll(cwd)
    const out = await toolsFor('sender').sendMessage({ sessionId: '', message: 'ready' })
    expect(text(out)).toContain(PEER_LIST_TOOL_NAME)
  })
})
