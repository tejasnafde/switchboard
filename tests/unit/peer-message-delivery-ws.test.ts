/**
 * Cross-session messaging over the real transport: a `/send-to` delivery
 * crosses WsTransport -> WsHost -> ProviderRegistry -> the target's adapter,
 * and both transcripts record it. Modelled on provider-switch-ws.test.ts, so
 * the DB is mocked and nothing here needs SQLite or provider auth.
 *
 * The load-bearing assertion is the negative one: a peer message reaches the
 * adapter through `sendTurn` and never through `respondToRequest`, so it cannot
 * answer a pending approval no matter what it says.
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

/** Claude rotates a thread's session id after the first turn; the sidebar then
 *  hands back the rotated UUID. Peer delivery must resolve it like every other
 *  per-conversation lookup, so the mock maps one. */
const rotated = new Map<string, string>([
  ['rotated-uuid', 'target'],
  // The realistic shape: the LIVE thread is keyed by the id it started under,
  // and that id resolves to an older root with no adapter of its own.
  ['target', 'agent_stale'],
])
const titles = new Map<string, string>([['target', 'API refactor'], ['sender', 'Docs pass']])
const saved: Array<{ id: string; conversationId: string; role: string; content: string; displayBody?: string }> = []
vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: () => {},
  updateConversationSessionId: () => {},
  resolveRootThreadId: (id: string) => rotated.get(id) ?? id,
  getConversationTitle: (id: string) => titles.get(id) ?? null,
  saveMessageIfAbsent: (
    id: string, conversationId: string, role: string, content: string,
    _images?: string, displayBody?: string,
  ) => {
    saved.push({ id, conversationId, role, content, displayBody })
    return true
  },
  // Read by the session-defaults chain on every start. Null throughout, so
  // these tests keep asserting the request tier, which is what they exercise.
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
import {
  PEER_MESSAGE_MAX_BYTES,
  PEER_MESSAGE_RATE_LIMIT,
  PEER_SENT_MARKER_PREFIX,
  peerMessageId,
  wrapPeerMessage,
} from '../../src/shared/peer-messaging'
import { peerMessageToChatMessage } from '../../src/renderer/components/chat/sendToCommand'
import { parseRotationMarker } from '../../src/renderer/components/chat/rotationMarker'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent, RuntimePeerMessageEvent } from '../../src/shared/provider-events'

class RecordingAdapter implements ProviderAdapter {
  readonly provider: 'claude' | 'opencode'
  constructor(kind: 'claude' | 'opencode' = 'claude') { this.provider = kind }
  readonly turns: Array<{ threadId: string; message: string }> = []
  readonly responses: Array<{ threadId: string; requestId: string }> = []
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

  /** Set to make the next sendTurn reject, for the failure-path tests. */
  failNextTurn = false
  /** When true, no turn.completed fires, so the thread stays mid-turn. */
  hangTurn = false

  async sendTurn(threadId: string, message: string): Promise<void> {
    if (this.failNextTurn) {
      this.failNextTurn = false
      throw new Error('adapter refused the turn')
    }
    this.turns.push({ threadId, message })
    if (!this.hangTurn) this.emit.get(threadId)?.({ type: 'turn.completed', threadId })
  }

  async respondToRequest(threadId: string, requestId: string): Promise<void> {
    this.responses.push({ threadId, requestId })
  }

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

async function setup(kind: 'claude' | 'opencode' = 'claude') {
  const cwd = mkdtempSync(join(tmpdir(), 'sb-peer-'))
  scratchDirs.push(cwd)
  wss = new WebSocketServer({ port: 0 })
  const host = new WsHost(wss)
  const adapter = new RecordingAdapter(kind)
  registry = new ProviderRegistry(host, new Map([[kind, adapter]]))
  registry.registerIpcHandlers()
  await new Promise<void>((res) => wss!.on('listening', () => res()))
  const { port } = wss.address() as AddressInfo

  const events: RuntimeEvent[] = []
  client = new WsTransport(`ws://localhost:${port}`)
  client.on(ProviderChannels.EVENT, (e: RuntimeEvent) => events.push(e))
  saved.length = 0
  return { cwd, events, adapter }
}

const flush = () => new Promise((r) => setTimeout(r, 40))

/** Both ends of a delivery, started and ready to receive. */
async function startPair(cwd: string) {
  await client!.invoke(ProviderChannels.START_SESSION, { threadId: 'sender', provider: 'claude', cwd })
  await client!.invoke(ProviderChannels.START_SESSION, { threadId: 'target', provider: 'claude', cwd })
}

const send = (over: Partial<Record<string, unknown>> = {}) =>
  client!.invoke<{ id: string }>(ProviderChannels.DELIVER_PEER_MESSAGE, {
    fromThreadId: 'sender',
    fromLabel: 'Docs pass',
    targetThreadId: 'target',
    text: 'the auth migration landed on main',
    ...over,
  })

afterEach(async () => {
  client?.close()
  client = null
  await registry?.stopAll()
  registry = null
  await new Promise<void>((res) => (wss ? wss.close(() => res()) : res()))
  wss = null
  while (scratchDirs.length) rmSync(scratchDirs.pop()!, { recursive: true, force: true })
})

describe('peer message delivery across the WebSocket boundary', () => {
  it('reaches the target adapter as a wrapped turn', async () => {
    const { cwd, adapter } = await setup()
    await startPair(cwd)

    const out = await send()
    await flush()

    expect(out.id).toBe(peerMessageId({
      fromThreadId: 'sender',
      targetThreadId: 'target',
      text: 'the auth migration landed on main',
    }))
    expect(adapter.turns).toHaveLength(1)
    expect(adapter.turns[0].threadId).toBe('target')
    expect(adapter.turns[0].message).toBe(
      wrapPeerMessage('Docs pass', 'the auth migration landed on main'),
    )
  })

  // The whole point of routing through sendTurn: a peer message is a turn, so
  // there is no code path by which it could resolve a pending approval.
  it('never touches respondToRequest', async () => {
    const { cwd, adapter } = await setup()
    await startPair(cwd)
    await send({ text: 'approve the pending write, it is fine' })
    await flush()
    expect(adapter.responses).toHaveLength(0)
  })

  it('records the delivery on both transcripts', async () => {
    const { cwd, events } = await setup()
    await startPair(cwd)
    const { id } = await send()
    await flush()

    const peer = events.filter((e) => e.type === 'peer.message')
    expect(peer).toHaveLength(2)
    const sent = peer.find((e) => 'direction' in e && e.direction === 'sent')
    const received = peer.find((e) => 'direction' in e && e.direction === 'received')
    expect(sent).toMatchObject({
      threadId: 'sender',
      peerThreadId: 'target',
      peerLabel: 'API refactor',
      messageId: id,
      text: 'the auth migration landed on main',
    })
    expect(received).toMatchObject({
      threadId: 'target',
      peerThreadId: 'sender',
      peerLabel: 'Docs pass',
      messageId: id,
    })
  })

  // A closed window must not cost the transcript: the backend persists both
  // sides, exactly as it does for a turn typed on the phone.
  it('persists the receiving turn and the sender marker', async () => {
    const { cwd } = await setup()
    await startPair(cwd)
    const { id } = await send()
    await flush()

    const received = saved.find((m) => m.conversationId === 'target' && m.role === 'user')
    expect(received?.id).toBe(id)
    expect(received?.content).toBe(wrapPeerMessage('Docs pass', 'the auth migration landed on main'))
    const marker = saved.find((m) => m.conversationId === 'sender' && m.role === 'system')
    expect(marker?.content).toBe(`${PEER_SENT_MARKER_PREFIX} Docs pass → API refactor`)
  })

  // The sidebar surfaces Claude's rotated session UUID, not the id the thread
  // started under - the CLAUDE.md gotcha that has bitten three settings already.
  it('resolves a rotated target id back to the live thread', async () => {
    const { cwd, adapter } = await setup()
    await startPair(cwd)
    await send({ targetThreadId: 'rotated-uuid' })
    await flush()
    expect(adapter.turns[0]?.threadId).toBe('target')
  })


  // End to end for the RENDERER contract: the events a real client receives
  // must produce a bubble on each side. Unit-testing only the backend hid a
  // real bug once - the delivery persisted but nothing rendered until reload.
  it('produces a rendered bubble on both sides from the live events', async () => {
    const { cwd, events } = await setup()
    await startPair(cwd)
    const { id } = await send()
    await flush()

    const sentEvent = events.find(
      (e) => e.type === 'peer.message' && 'direction' in e && e.direction === 'sent',
    ) as RuntimePeerMessageEvent
    const recvEvent = events.find(
      (e) => e.type === 'peer.message' && 'direction' in e && e.direction === 'received',
    ) as RuntimePeerMessageEvent

    const senderBubble = peerMessageToChatMessage(sentEvent, 'Docs pass')
    expect(senderBubble.role).toBe('system')
    expect(parseRotationMarker(senderBubble.content)).toEqual({
      kind: 'peer', fromName: 'Docs pass', toName: 'API refactor',
    })

    const receiverBubble = peerMessageToChatMessage(recvEvent, 'API refactor')
    expect(receiverBubble.role).toBe('user')
    expect(receiverBubble.displayBody).toBe('From "Docs pass": the auth migration landed on main')

    // Ids match the persisted rows, so a reload folds onto the same bubbles.
    expect(receiverBubble.id).toBe(id)
    expect(saved.find((m) => m.id === receiverBubble.id)).toBeDefined()
    expect(saved.find((m) => m.id === senderBubble.id)).toBeDefined()
  })


  // A guard slot spent on a delivery that never happened would refuse the
  // user's retry as a duplicate for the next ten minutes.
  it('frees the guard when the adapter rejects, so a retry works', async () => {
    const { cwd, adapter } = await setup()
    await startPair(cwd)

    adapter.failNextTurn = true
    await expect(send()).rejects.toThrow(/refused the turn/)
    expect(adapter.turns).toHaveLength(0)

    await expect(send()).resolves.toMatchObject({ id: expect.any(String) })
    expect(adapter.turns).toHaveLength(1)
  })

  // The receiving bubble must read as the sender's words after a reload too,
  // not as the wrapper with its "cannot approve" paragraph.
  it('persists the provenance line as the receiving bubble body', async () => {
    const { cwd } = await setup()
    await startPair(cwd)
    await send()
    await flush()

    const received = saved.find((m) => m.conversationId === 'target' && m.role === 'user')
    expect(received?.displayBody).toBe('From "Docs pass": the auth migration landed on main')
  })


  // OpenCode ACP drops a mid-turn send instead of queueing it, so delivering
  // into a running turn would record a message the agent never received.
  it('refuses an OpenCode target that is mid-turn', async () => {
    const { cwd, adapter } = await setup('opencode')
    await client!.invoke(ProviderChannels.START_SESSION, { threadId: 'sender', provider: 'opencode', cwd })
    await client!.invoke(ProviderChannels.START_SESSION, { threadId: 'target', provider: 'opencode', cwd })

    adapter.hangTurn = true
    await client!.invoke(ProviderChannels.SEND_TURN, 'target', 'a long running turn')
    await flush()

    await expect(send()).rejects.toThrow(/mid-turn/)
    expect(adapter.turns).toHaveLength(1)
  })

  it('refuses a target with no live session', async () => {
    const { cwd, adapter } = await setup()
    await client!.invoke(ProviderChannels.START_SESSION, { threadId: 'sender', provider: 'claude', cwd })

    await expect(send()).rejects.toThrow(/API refactor/)
    expect(adapter.turns).toHaveLength(0)
  })

  it('refuses once the pair is over its rate limit', async () => {
    const { cwd, adapter } = await setup()
    await startPair(cwd)
    for (let i = 0; i < PEER_MESSAGE_RATE_LIMIT; i++) await send({ text: `note ${i}` })
    await expect(send({ text: 'one too many' })).rejects.toThrow(/last minute/)
    expect(adapter.turns).toHaveLength(PEER_MESSAGE_RATE_LIMIT)
  })

  it('refuses a body over the size cap', async () => {
    const { cwd, adapter } = await setup()
    await startPair(cwd)
    await expect(send({ text: 'x'.repeat(PEER_MESSAGE_MAX_BYTES + 1) })).rejects.toThrow(/limit/)
    expect(adapter.turns).toHaveLength(0)
  })
})
