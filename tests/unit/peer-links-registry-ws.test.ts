/**
 * Session links against the real registry: the user links sessions over the
 * wire, and the agent tools then send along (and outside) those links.
 *
 * Harness mirrors peer-agent-tools-ws.test.ts. The load-bearing assertions:
 * a link lifts the hop depth and per-sender budget only along its own edge,
 * the edge's budget runs out and is renewed by a human turn, and a stop or an
 * archive takes the link away.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import './helpers/registry-session-mocks'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type AddressInfo } from 'ws'

vi.mock('../../src/main/db/provider-instances', () => ({
  resolveProviderInstance: (agentType: string, id?: string) => ({
    id: id ?? `${agentType}-default`,
    env: {},
    oauthDir: null,
  }),
  listOauthDirsForAgent: () => [],
}))

const titles = new Map<string, string>([
  ['hub', 'Lead'],
  ['w1', 'Worker A'],
  ['w2', 'Worker B'],
  ['w3', 'Worker C'],
  ['outsider', 'Unrelated'],
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
  getConversationExecutionRoot: () => null,
  getConversationProviderInstanceId: () => null,
  getSetting: () => null,
}))

import { WsHost } from '../../src/main/backend/ws-host'
import { ProviderRegistry, notifyConversationArchived } from '../../src/main/provider/provider-registry'
import { WsTransport } from '../../src/shared/ws-transport'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import { createPeerToolHandlers } from '../../src/main/provider/peer-tools'
import { PEER_AGENT_SEND_BUDGET, PEER_MESSAGE_RATE_LIMIT, PEER_MESSAGE_RATE_WINDOW_MS } from '../../src/shared/peer-messaging'
import { PEER_LINK_MESSAGE_BUDGET, type PeerLinkView } from '../../src/shared/peer-links'
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
  const cwd = mkdtempSync(join(tmpdir(), 'sb-peer-links-'))
  scratchDirs.push(cwd)
  wss = new WebSocketServer({ port: 0 })
  const host = new WsHost(wss)
  const adapter = new RecordingAdapter()
  registry = new ProviderRegistry(host, new Map([['claude', adapter]]))
  registry.registerIpcHandlers()
  await new Promise<void>((res) => wss!.on('listening', () => res()))
  const { port } = wss.address() as AddressInfo

  const events: RuntimeEvent[] = []
  const linkChanges: Array<{ threadIds: string[] }> = []
  client = new WsTransport(`ws://localhost:${port}`)
  client.on(ProviderChannels.EVENT, (e: RuntimeEvent) => events.push(e))
  client.on(ProviderChannels.PEER_LINKS_CHANGED, (change: { threadIds: string[] }) => linkChanges.push(change))
  saved.length = 0
  return { cwd, events, linkChanges, adapter, registry }
}

const flush = () => new Promise((r) => setTimeout(r, 40))

/** Every session this suite messages between, started and ready to receive. */
async function startAll(cwd: string, ids: string[] = ['hub', 'w1', 'w2', 'w3', 'outsider']) {
  for (const threadId of ids) {
    await client!.invoke(ProviderChannels.START_SESSION, { threadId, provider: 'claude', cwd })
  }
}

/** The tools as the model in `from` calls them. */
const toolsFor = (from: string) => createPeerToolHandlers(registry!, from)

const text = (result: { content: Array<{ text: string }> }) =>
  result.content.map((c) => c.text).join('\n')

afterEach(async () => {
  vi.restoreAllMocks()
  client?.close()
  client = null
  await registry?.stopAll()
  registry = null
  await new Promise<void>((res) => (wss ? wss.close(() => res()) : res()))
  wss = null
  while (scratchDirs.length) rmSync(scratchDirs.pop()!, { recursive: true, force: true })
})


const link = (threadId: string, peerThreadId: string) =>
  client!.invoke(ProviderChannels.LINK_PEER, { threadId, peerThreadId }) as Promise<PeerLinkView[]>
const linksOf = (threadId: string) =>
  client!.invoke(ProviderChannels.LIST_PEER_LINKS, { threadId }) as Promise<PeerLinkView[]>

/** A controllable clock, so the per-pair rate window can pass without waiting. */
function fakeClock() {
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  return { advance: (ms: number) => { now += ms } }
}

describe('linking', () => {
  it('links two live sessions and reports the link on both sides', async () => {
    const { cwd, linkChanges } = await setup()
    await startAll(cwd)
    const mine = await link('hub', 'w1')
    expect(mine).toMatchObject([{ peerThreadId: 'w1', title: 'Worker A', used: 0, budget: PEER_LINK_MESSAGE_BUDGET }])
    expect(await linksOf('w1')).toMatchObject([{ peerThreadId: 'hub', title: 'Lead' }])
    await flush()
    expect(linkChanges.at(-1)?.threadIds.sort()).toEqual(['hub', 'w1'])
  })

  it('refuses a session that is not running', async () => {
    const { cwd } = await setup()
    await startAll(cwd, ['hub'])
    await expect(link('hub', 'w1')).rejects.toThrow(/not running/i)
  })

  it('marks linked sessions in list_agent_sessions', async () => {
    const { cwd } = await setup()
    await startAll(cwd)
    await link('hub', 'w1')
    const body = text(await toolsFor('hub').listSessions())
    const listed = JSON.parse(body.slice(body.indexOf('['))) as Array<{ sessionId: string; linked: boolean }>
    expect(Object.fromEntries(listed.map((s) => [s.sessionId, s.linked]))).toEqual({
      w1: true, w2: false, w3: false, outsider: false,
    })
    // Workers see only the hub as linked, not each other.
    const fromWorker = text(await toolsFor('w2').listSessions())
    expect(fromWorker).not.toContain('"linked": true')
  })
})

describe('a hub linked with three workers', () => {
  it('fans out past the per-sender budget, and the workers can answer it', async () => {
    const { cwd, adapter } = await setup()
    await startAll(cwd)
    for (const w of ['w1', 'w2', 'w3']) await link('hub', w)

    // More sends than the per-sender budget allows, spread so no pair's rate binds.
    const sends = PEER_AGENT_SEND_BUDGET + 3
    for (let i = 0; i < sends; i++) {
      const out = await toolsFor('hub').sendMessage({ sessionId: ['w1', 'w2', 'w3'][i % 3], message: `task ${i}` })
      expect(out.isError).toBeFalsy()
    }
    // w1 is acting on a peer message (depth 1), and still answers along its link.
    const reply = await toolsFor('w1').sendMessage({ sessionId: 'hub', message: 'done with task 0' })
    expect(reply.isError).toBeFalsy()
    // And the hub, now acting on that reply, answers back.
    expect((await toolsFor('hub').sendMessage({ sessionId: 'w1', message: 'thanks, next one' })).isError).toBeFalsy()
    expect(adapter.turns).toHaveLength(sends + 2)
  })

  it('keeps the workers from messaging each other', async () => {
    const { cwd, adapter } = await setup()
    await startAll(cwd)
    for (const w of ['w1', 'w2', 'w3']) await link('hub', w)
    await toolsFor('hub').sendMessage({ sessionId: 'w1', message: 'look at auth' })

    const sideways = await toolsFor('w1').sendMessage({ sessionId: 'w2', message: 'auth is yours' })
    expect(sideways.isError).toBe(true)
    expect(text(sideways)).toMatch(/acting on a message from another session/i)
    expect(adapter.turns).toHaveLength(1)
  })

  it('keeps the hop limit for a linked session sending to an unlinked one', async () => {
    const { cwd } = await setup()
    await startAll(cwd)
    await link('hub', 'w1')
    await toolsFor('w1').sendMessage({ sessionId: 'hub', message: 'started' })

    const out = await toolsFor('hub').sendMessage({ sessionId: 'outsider', message: 'pass it on' })
    expect(out.isError).toBe(true)
    expect(text(out)).toMatch(/acting on a message from another session/i)
  })
})

describe('the edge budget', () => {
  it('runs out, refuses as tool output, and is renewed by a human turn in either session', async () => {
    const { cwd, adapter } = await setup()
    await startAll(cwd, ['hub', 'w1'])
    await link('hub', 'w1')
    const clock = fakeClock()

    let n = 0
    while (n < PEER_LINK_MESSAGE_BUDGET) {
      for (let i = 0; i < PEER_MESSAGE_RATE_LIMIT && n < PEER_LINK_MESSAGE_BUDGET; i++, n++) {
        const [from, to] = n % 2 === 0 ? ['hub', 'w1'] : ['w1', 'hub']
        expect((await toolsFor(from).sendMessage({ sessionId: to, message: `round ${n}` })).isError).toBeFalsy()
      }
      clock.advance(PEER_MESSAGE_RATE_WINDOW_MS)
    }
    expect((await linksOf('hub'))[0].used).toBe(PEER_LINK_MESSAGE_BUDGET)

    const over = await toolsFor('hub').sendMessage({ sessionId: 'w1', message: 'one more' })
    expect(over.isError).toBe(true)
    expect(text(over)).toMatch(/its limit/i)
    expect(text(over)).toMatch(/relink/i)
    expect(adapter.turns).toHaveLength(PEER_LINK_MESSAGE_BUDGET)

    // The user typing in the WORKER renews the edge for the hub too.
    await client!.invoke(ProviderChannels.SEND_TURN, 'w1', 'keep going')
    await flush()
    expect((await linksOf('hub'))[0].used).toBe(0)
    expect((await toolsFor('hub').sendMessage({ sessionId: 'w1', message: 'one more' })).isError).toBeFalsy()
  })

  it('gives the charge back when the per-pair rate refuses the send', async () => {
    const { cwd } = await setup()
    await startAll(cwd, ['hub', 'w1'])
    await link('hub', 'w1')
    for (let i = 0; i < PEER_MESSAGE_RATE_LIMIT; i++) await toolsFor('hub').sendMessage({ sessionId: 'w1', message: `m${i}` })
    const limited = await toolsFor('hub').sendMessage({ sessionId: 'w1', message: 'too fast' })
    expect(limited.isError).toBe(true)
    expect((await linksOf('hub'))[0].used).toBe(PEER_MESSAGE_RATE_LIMIT)
  })
})

describe('unlinking', () => {
  it('removes one link or all of them', async () => {
    const { cwd } = await setup()
    await startAll(cwd)
    for (const w of ['w1', 'w2', 'w3']) await link('hub', w)
    await client!.invoke(ProviderChannels.UNLINK_PEER, { threadId: 'hub', peerThreadId: 'w2' })
    expect((await linksOf('hub')).map((l) => l.peerThreadId).sort()).toEqual(['w1', 'w3'])
    await client!.invoke(ProviderChannels.UNLINK_PEER, { threadId: 'hub' })
    expect(await linksOf('hub')).toEqual([])
    expect(await linksOf('w1')).toEqual([])
  })

  it('happens when either session stops', async () => {
    const { cwd, linkChanges } = await setup()
    await startAll(cwd)
    await link('hub', 'w1')
    await link('hub', 'w2')
    await client!.invoke(ProviderChannels.STOP_SESSION, 'w1')
    await flush()
    expect((await linksOf('hub')).map((l) => l.peerThreadId)).toEqual(['w2'])
    expect(linkChanges.at(-1)?.threadIds.sort()).toEqual(['hub', 'w1'])
  })

  it('happens when either session is archived', async () => {
    const { cwd } = await setup()
    await startAll(cwd)
    await link('hub', 'w1')
    notifyConversationArchived('hub')
    expect(await linksOf('w1')).toEqual([])
  })

  it('refuses a send that needed the link once it is gone', async () => {
    const { cwd, adapter } = await setup()
    await startAll(cwd)
    const out = await toolsFor('hub').sendMessage({ sessionId: 'w1', message: 'skipped its card', requireLink: true })
    expect(out.isError).toBe(true)
    expect(text(out)).toMatch(/removed the link/i)
    expect(adapter.turns).toHaveLength(0)
  })

  it('puts the ordinary limits back', async () => {
    const { cwd } = await setup()
    await startAll(cwd)
    await link('hub', 'w1')
    await toolsFor('w1').sendMessage({ sessionId: 'hub', message: 'started' })
    await client!.invoke(ProviderChannels.UNLINK_PEER, { threadId: 'hub', peerThreadId: 'w1' })
    const back = await toolsFor('hub').sendMessage({ sessionId: 'w1', message: 'and now?' })
    expect(back.isError).toBe(true)
    expect(text(back)).toMatch(/acting on a message from another session/i)
  })
})
