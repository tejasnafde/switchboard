/**
 * Lineage messages against the real registry: a parent and its open children
 * talk on an edge Switchboard made, a busy child gets a steer or a queued
 * message as its agent allows, and nobody else reaches a child.
 */
import { describe, expect, it, vi } from 'vitest'
import './helpers/registry-session-mocks'

vi.mock('../../src/main/db/provider-instances', () => ({
  resolveProviderInstance: (agentType: string, id?: string) => ({
    id: id ?? `${agentType}-default`,
    agentType,
    displayName: id ?? `${agentType}-default`,
    enabled: true,
    env: {},
    oauthDir: null,
  }),
  getProviderInstanceFull: () => null,
  listOauthDirsForAgent: () => [],
}))

vi.mock('../../src/main/provider/remote-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/remote-gate')>()
  return { ...actual, remoteProviderLoginPrompt: () => null }
})

const hubFlag = vi.hoisted(() => ({ on: true }))
const children = [
  { childId: 'child1', parentId: 'parent1', title: 'Claude child', phase: 'open' },
  { childId: 'child2', parentId: 'parent1', title: 'Gemini child', phase: 'open' },
]

// process.cwd(): a folder that exists on every OS, since START_SESSION checks the cwd is readable.
vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: () => {},
  recordConversationSegment: () => {},
  updateConversationSessionId: () => {},
  saveMessageIfAbsent: () => true,
  rewriteSystemMarker: () => null,
  getConversationById: (id: string) => ({ id, project_path: process.cwd() }),
  getConversationTitle: () => null,
  resolveRootThreadId: (id: string) => id,
  getConversationRuntimeMode: () => null,
  getConversationModel: () => null,
  getConversationReasoningEffort: () => null,
  getConversationAgentType: () => null,
  getConversationProviderInstanceId: () => null,
  getSetting: (key: string) => (key === 'labs.hub_children' && hubFlag.on ? 'true' : null),
  getConversationExecutionRoot: () => null,
  commitConversationExecutionRoot: () => {},
  commitConversationProviderSwitch: () => {},
  getDb: () => ({}),
  deleteUserMessage: () => {},
  isConversationArchived: () => false,
  openChildParentId: (id: string) => children.find((c) => c.childId === id)?.parentId ?? null,
  listHubChildrenInPhase: (phase: string) => children.filter((c) => c.phase === phase),
  threadFamilyIds: (id: string) => [id],
  listHubChildren: () => [],
  lastHubWakes: () => new Map(),
  listPendingHubWakes: () => [],
  getHubParent: () => null,
}))

import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import type { BackendHost } from '../../src/main/backend/host'
import type { ProviderAdapter, ProviderKind, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent } from '../../src/shared/provider-events'

class FakeHost implements BackendHost {
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn)
  }
  on(): void {}
  emit(): void {}
  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    const fn = this.handlers.get(channel)
    if (!fn) throw new Error(`no handler registered for ${channel}`)
    return (await fn(...args)) as T
  }
}

class Adapter implements ProviderAdapter {
  emit = new Map<string, (e: RuntimeEvent) => void>()
  sends: Array<{ threadId: string; delivery: string; queuedId?: string }> = []
  answered = 0
  constructor(readonly provider: ProviderKind) {}
  async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    this.emit.set(opts.threadId, onEvent)
    return {
      threadId: opts.threadId,
      provider: this.provider,
      status: 'idle',
      runtimeMode: 'sandbox',
      cwd: opts.cwd,
      createdAt: 0,
    }
  }
  async sendTurn(
    threadId: string,
    _message: string,
    _mode?: unknown,
    _images?: unknown,
    delivery?: string,
    queuedId?: string,
  ): Promise<void> {
    this.sends.push({ threadId, delivery: delivery ?? 'turn', ...(queuedId ? { queuedId } : {}) })
  }
  async respondToRequest(): Promise<void> {
    this.answered++
  }
  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async setRuntimeMode(): Promise<void> {}
  async isAvailable(): Promise<boolean> {
    return true
  }
}

async function setup() {
  const host = new FakeHost()
  const claude = new Adapter('claude')
  const gemini = new Adapter('gemini')
  const registry = new ProviderRegistry(
    host,
    new Map<ProviderKind, ProviderAdapter>([
      ['claude', claude],
      ['gemini', gemini],
    ]),
  )
  registry.registerIpcHandlers()
  for (const [threadId, provider] of [
    ['parent1', 'claude'],
    ['child1', 'claude'],
    ['child2', 'gemini'],
    ['other', 'claude'],
    ['gem', 'gemini'],
  ] as const)
    await host.invoke(ProviderChannels.START_SESSION, { threadId, provider, cwd: process.cwd() })
  /** The child starts a turn of its own, as a running agent would be. */
  const busy = (adapter: Adapter, threadId: string) =>
    adapter.emit.get(threadId)!({ type: 'status', threadId, status: 'running', newTurn: true })
  let n = 0
  const send = (from: string, to: string, delivery?: 'queue' | 'steer') =>
    registry.deliverPeerMessage({
      fromThreadId: from,
      targetThreadId: to,
      text: `note ${++n} from ${from}`,
      initiator: 'agent',
      ...(delivery ? { delivery } : {}),
    })
  return { host, registry, claude, gemini, busy, send }
}

describe('lineage messages', () => {
  it('steers a busy Claude child and queues to a busy Gemini child', async () => {
    const { claude, gemini, busy, send } = await setup()
    busy(claude, 'child1')
    busy(gemini, 'child2')
    expect(await send('parent1', 'child1', 'steer')).toEqual({ id: expect.any(String) })
    expect(claude.sends.at(-1)).toEqual({ threadId: 'child1', delivery: 'steer' })
    const queued = await send('parent1', 'child2', 'steer')
    expect(queued).toMatchObject({ queued: true })
    expect(gemini.sends.at(-1)).toEqual({ threadId: 'child2', delivery: 'queue', queuedId: queued.id })
  })

  it('queues by default, and queues a steer while the child compacts or is being stopped', async () => {
    const { host, claude, busy, send } = await setup()
    busy(claude, 'child1')
    await send('parent1', 'child1', 'queue')
    expect(claude.sends.at(-1)?.delivery).toBe('queue')

    claude.emit.get('child1')!({ type: 'status', threadId: 'child1', status: 'running', compacting: true })
    await send('parent1', 'child1', 'steer')
    expect(claude.sends.at(-1)?.delivery).toBe('queue')
    claude.emit.get('child1')!({ type: 'status', threadId: 'child1', status: 'running', compacting: false })
    await send('parent1', 'child1', 'steer')
    expect(claude.sends.at(-1)?.delivery).toBe('steer')
    claude.emit.get('child1')!({ type: 'status', threadId: 'child1', status: 'running', compacting: true })

    // The compacting turn ends; the next one is being stopped.
    claude.emit.get('child1')!({ type: 'turn.completed', threadId: 'child1' })
    busy(claude, 'child1')
    await send('child1', 'parent1', 'steer')
    expect(claude.sends.at(-1)).toEqual({ threadId: 'parent1', delivery: 'turn' })
    await host.invoke(ProviderChannels.INTERRUPT, 'child1')
    await send('parent1', 'child1', 'steer')
    expect(claude.sends.at(-1)?.delivery).toBe('queue')
  })

  it('never answers an open approval of the child', async () => {
    const { claude, send } = await setup()
    claude.emit.get('child1')!({
      type: 'request.opened',
      threadId: 'child1',
      requestId: 'r1',
      requestType: 'command',
      toolName: 'Bash',
      detail: 'rm -rf build',
    } as RuntimeEvent)
    await send('parent1', 'child1')
    expect(claude.answered).toBe(0)
  })

  it('reaches a child only from its parent, and lets a child message only its parent', async () => {
    const { registry, send } = await setup()
    await expect(send('other', 'child1')).rejects.toThrow('Message the hub')
    await expect(send('child1', 'other')).rejects.toThrow('only its parent')
    await expect(send('child1', 'child2')).rejects.toThrow()
    await expect(send('child1', 'parent1')).resolves.toMatchObject({ id: expect.any(String) })
    expect(registry.isLineagePeer('child1', 'parent1')).toBe(true)
    expect(registry.listPeerSessions('parent1').filter((s) => s.hub)).toEqual([
      expect.objectContaining({ sessionId: 'child1', hub: 'child', linked: true }),
      expect.objectContaining({ sessionId: 'child2', hub: 'child', linked: true }),
    ])
    expect(registry.listPeerSessions('child1').find((s) => s.sessionId === 'parent1')?.hub).toBe('parent')
  })

  it('refuses /link to a child, and keeps the lineage edge through /unlink', async () => {
    const { host, registry } = await setup()
    await expect(
      host.invoke(ProviderChannels.LINK_PEER, { threadId: 'other', peerThreadId: 'child1' }),
    ).rejects.toThrow('Message the hub')
    await expect(
      host.invoke(ProviderChannels.LINK_PEER, { threadId: 'child1', peerThreadId: 'parent1' }),
    ).rejects.toThrow('Message the hub')
    registry.unlinkPeers('parent1')
    expect(registry.isLineagePeer('parent1', 'child1')).toBe(true)
    expect(registry.listPeerLinks('parent1')).toEqual([])
  })

  it('makes no lineage edge with the flag off', async () => {
    hubFlag.on = false
    try {
      const { registry, busy, gemini, send } = await setup()
      expect(registry.isLineagePeer('parent1', 'child1')).toBe(false)
      // Without a delivery, a busy ACP child refuses as before.
      busy(gemini, 'child2')
      await expect(send('parent1', 'child2')).rejects.toThrow('mid-turn')
    } finally {
      hubFlag.on = true
    }
  })

  it('ignores a delivery a client sends with /send-to', async () => {
    const { host, gemini, busy } = await setup()
    busy(gemini, 'gem')
    await expect(
      host.invoke(ProviderChannels.DELIVER_PEER_MESSAGE, {
        fromThreadId: 'other',
        targetThreadId: 'gem',
        text: 'typed',
        delivery: 'queue',
      }),
    ).rejects.toThrow('mid-turn')
  })
})
