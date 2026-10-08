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
  getProviderInstanceFull: (id: string) => ({
    id,
    agentType: 'claude-code',
    displayName: id,
    enabled: true,
    env: {},
    oauthDir: null,
  }),
  listOauthDirsForAgent: () => [],
}))

vi.mock('../../src/main/provider/remote-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/remote-gate')>()
  return { ...actual, remoteProviderLoginPrompt: () => null }
})

vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: () => {},
  recordConversationSegment: () => {},
  updateConversationSessionId: () => {},
  saveMessageIfAbsent: () => true,
  getConversationById: (id: string) => ({ id }),
  getConversationTitle: () => null,
  resolveRootThreadId: (id: string) => id,
  getConversationRuntimeMode: () => null,
  getConversationModel: () => null,
  getConversationAgentType: () => null,
  getConversationProviderInstanceId: () => null,
  getSetting: () => null,
  getConversationExecutionRoot: () => null,
  commitConversationExecutionRoot: () => {},
  commitConversationProviderSwitch: () => {},
  getDb: () => ({}),
  deleteUserMessage: () => {},
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
  emitted: unknown[][] = []
  emit(...args: unknown[]): void {
    this.emitted.push(args)
  }
  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    const fn = this.handlers.get(channel)
    if (!fn) throw new Error(`no handler registered for ${channel}`)
    return (await fn(...args)) as T
  }
}

/** A queue held after a failed turn, and a queued message that could not start. */
class Adapter implements ProviderAdapter {
  readonly provider = 'claude' as const
  onEvent!: (e: RuntimeEvent) => void
  resumed: string[] = []
  async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    this.onEvent = onEvent
    return {
      threadId: opts.threadId,
      provider: 'claude',
      status: 'idle',
      runtimeMode: 'sandbox',
      cwd: opts.cwd,
      createdAt: 0,
    }
  }
  async sendTurn(): Promise<void> {}
  async respondToRequest(): Promise<void> {}
  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async setRuntimeMode(): Promise<void> {}
  async isAvailable(): Promise<boolean> {
    return true
  }
  async cancelQueuedTurn(): Promise<boolean> {
    throw new Error('the adapter no longer has it')
  }
  async resumeQueuedTurns(threadId: string): Promise<boolean> {
    this.resumed.push(threadId)
    return true
  }
}

describe('held queue in the registry', () => {
  it('lists a failed message until cancel takes it back, without asking the adapter', async () => {
    const host = new FakeHost()
    const adapter = new Adapter()
    const registry = new ProviderRegistry(host, new Map([['claude', adapter]]))
    registry.registerIpcHandlers()
    await host.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd: '/tmp' })
    adapter.onEvent({ type: 'turn.queued', threadId: 't1', messageId: 'remote_a', text: 'do it', queuedAt: 1 })
    adapter.onEvent({ type: 'turn.queued', threadId: 't1', messageId: 'remote_b', text: 'then this', queuedAt: 2 })
    adapter.onEvent({ type: 'turn.dequeued', threadId: 't1', messageId: 'remote_a', reason: 'started' })
    adapter.onEvent({ type: 'turn.dequeued', threadId: 't1', messageId: 'remote_a', reason: 'failed', error: 'limit' })
    adapter.onEvent({ type: 'turn.queue-held', threadId: 't1', held: true, reason: 'limit' })

    expect(await host.invoke(ProviderChannels.LIST_QUEUED_TURNS, 't1')).toEqual([
      { threadId: 't1', messageId: 'remote_b', text: 'then this', queuedAt: 2, held: true },
      { threadId: 't1', messageId: 'remote_a', text: 'do it', queuedAt: 1, failed: 'limit' },
    ])
    expect(await host.invoke(ProviderChannels.PROMOTE_QUEUED_TURN, 't1', 'remote_a')).toMatchObject({
      ok: false,
      reason: 'failed',
    })
    expect(await host.invoke(ProviderChannels.CANCEL_QUEUED_TURN, 't1', 'remote_a')).toMatchObject({
      ok: true,
      turn: { text: 'do it' },
    })
    const events = host.emitted.filter(([c]) => c === ProviderChannels.EVENT).map(([, e]) => e as RuntimeEvent)
    expect(events.at(-1)).toEqual({ type: 'turn.dequeued', threadId: 't1', messageId: 'remote_a', reason: 'cancelled' })

    expect(await host.invoke(ProviderChannels.RESUME_QUEUED_TURNS, 't1')).toEqual({ ok: true })
    expect(adapter.resumed).toEqual(['t1'])
  })
})
