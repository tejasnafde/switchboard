/**
 * The registry's snooze wakes against the real event order of the adapters:
 * a Claude query failure ends the turn before it reports the error, and a
 * person's message is reported with the time its send started.
 */
import { describe, expect, it, vi } from 'vitest'
import './helpers/registry-session-mocks'
import { shouldWakeOn, NOT_SNOOZED, type InboxEvent } from '../../src/shared/chat-snooze'

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

const snoozer = vi.hoisted(() => ({ events: [] as Array<{ id: string; event: InboxEvent }> }))
vi.mock('../../src/main/conversations/chat-snooze', () => ({
  chatSnoozer: () => ({
    onEvent: (id: string, event: InboxEvent) => snoozer.events.push({ id, event }),
    onCleared: () => {},
  }),
}))

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
  getSetting: () => null,
  getConversationExecutionRoot: () => null,
  commitConversationExecutionRoot: () => {},
  commitConversationProviderSwitch: () => {},
  getDb: () => ({}),
  deleteUserMessage: () => {},
  isConversationArchived: () => false,
  openChildParentId: () => null,
  listHubChildrenInPhase: () => [],
  threadFamilyIds: (id: string) => [id],
  listHubChildren: () => [],
  lastHubWakes: () => new Map(),
  listPendingHubWakes: () => [],
  getHubParent: () => null,
  getHubChild: () => null,
}))

import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import type { BackendHost } from '../../src/main/backend/host'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
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
  readonly provider = 'claude' as const
  emit = new Map<string, (e: RuntimeEvent) => void>()
  /** Runs while a send is pending, before it resolves. */
  duringSend: (() => Promise<void>) | null = null
  async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    this.emit.set(opts.threadId, onEvent)
    return {
      threadId: opts.threadId,
      provider: 'claude',
      status: 'idle',
      runtimeMode: 'sandbox',
      cwd: opts.cwd,
      createdAt: 0,
    }
  }
  async sendTurn(): Promise<void> {
    await this.duringSend?.()
  }
  async respondToRequest(): Promise<void> {}
  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async setRuntimeMode(): Promise<void> {}
  async isAvailable(): Promise<boolean> {
    return true
  }
}

async function setup() {
  snoozer.events.length = 0
  const host = new FakeHost()
  const adapter = new Adapter()
  const registry = new ProviderRegistry(host, new Map([['claude', adapter]]))
  registry.registerIpcHandlers()
  for (const threadId of ['a', 'b'])
    await host.invoke(ProviderChannels.START_SESSION, { threadId, provider: 'claude', cwd: process.cwd() })
  const event = (e: RuntimeEvent) => adapter.emit.get(e.threadId)!(e)
  const errorWakes = () => snoozer.events.filter((e) => e.event.kind === 'error')
  return { host, adapter, event, errorWakes }
}

describe('snooze wakes from the registry', () => {
  it('a Claude query failure wakes the chat although its turn end comes before the error', async () => {
    const { event, errorWakes } = await setup()
    event({ type: 'status', threadId: 'a', status: 'running', newTurn: true })
    // What `endTurnWithoutResult` and the catch after it send.
    event({ type: 'turn.completed', threadId: 'a' })
    event({ type: 'error', threadId: 'a', message: 'query failed' })
    event({ type: 'status', threadId: 'a', status: 'error' })
    expect(errorWakes()).toEqual([{ id: 'a', event: { kind: 'error', at: expect.any(Number) } }])
  })

  it('an error mid-turn wakes it, as before', async () => {
    const { event, errorWakes } = await setup()
    event({ type: 'status', threadId: 'a', status: 'running', newTurn: true })
    event({ type: 'error', threadId: 'a', message: 'rate limited' })
    event({ type: 'turn.completed', threadId: 'a' })
    expect(errorWakes()).toHaveLength(1)
  })

  it('a normal turn end does not wake it, and neither does a later error with no turn', async () => {
    const { event, errorWakes } = await setup()
    event({ type: 'status', threadId: 'a', status: 'running', newTurn: true })
    event({ type: 'turn.completed', threadId: 'a' })
    event({ type: 'status', threadId: 'a', status: 'idle' })
    event({ type: 'error', threadId: 'a', message: 'session could not restart' })
    expect(errorWakes()).toEqual([])
    // A turn end in another chat does not make this chat's error a turn failure.
    event({ type: 'turn.completed', threadId: 'b' })
    event({ type: 'error', threadId: 'a', message: 'again' })
    expect(errorWakes()).toEqual([])
  })

  it('a person message sent before the snooze, delivered after the write, does not wake it', async () => {
    const { host, adapter } = await setup()
    let snoozedAt = 0
    adapter.duringSend = async () => {
      await new Promise((r) => setTimeout(r, 5))
      // The user snoozes the target while the send is pending.
      snoozedAt = Date.now()
    }
    await host.invoke(ProviderChannels.DELIVER_PEER_MESSAGE, { fromThreadId: 'a', targetThreadId: 'b', text: 'hi' })
    const [reported] = snoozer.events.filter((e) => e.event.kind === 'message')
    expect(reported).toMatchObject({ id: 'b', event: { kind: 'message', from: 'person' } })
    const state = { ...NOT_SNOOZED, snoozedUntil: snoozedAt + 60_000, snoozedAt, snoozeRev: 1 }
    expect(shouldWakeOn(reported.event, state)).toBeNull()
    // One sent after the snooze wakes it.
    expect(shouldWakeOn({ ...reported.event, at: snoozedAt + 1 } as InboxEvent, state)).toBe('message')
  })
})
