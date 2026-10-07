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
    id, agentType: 'claude-code', displayName: id, enabled: true, env: {}, oauthDir: null,
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
}))

import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import type { BackendHost } from '../../src/main/backend/host'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent } from '../../src/shared/provider-events'
import { REQUEST_EXPIRED } from '../../src/shared/provider-events'

class FakeHost implements BackendHost {
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn)
  }
  on(): void {}
  emitted: unknown[][] = []
  emit(...args: unknown[]): void { this.emitted.push(args) }
  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    const fn = this.handlers.get(channel)
    if (!fn) throw new Error(`no handler registered for ${channel}`)
    return (await fn(...args)) as T
  }
}

/**
 * An approval or question whose provider died: answering it used to be a
 * silent success at every layer, and the card hung on "Approving...".
 */
class Adapter implements ProviderAdapter {
  readonly provider = 'claude' as const
  onEvent!: (e: RuntimeEvent) => void
  responded: string[] = []
  async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    this.onEvent = onEvent
    return { threadId: opts.threadId, provider: 'claude', status: 'idle', runtimeMode: 'sandbox', cwd: opts.cwd, createdAt: 0 }
  }
  async sendTurn(): Promise<void> {}
  async respondToRequest(_t: string, requestId: string): Promise<void> { this.responded.push(requestId) }
  async answerQuestion(_t: string, requestId: string): Promise<void> { this.responded.push(requestId) }
  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async setRuntimeMode(): Promise<void> {}
  async isAvailable(): Promise<boolean> { return true }
}

async function started() {
  const host = new FakeHost()
  const adapter = new Adapter()
  const registry = new ProviderRegistry(host, new Map([['claude', adapter]]))
  registry.registerIpcHandlers()
  await host.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd: '/tmp' })
  adapter.onEvent({ type: 'request.opened', threadId: 't1', requestId: 'r1', requestType: 'command', toolName: 'Bash', detail: 'ls' })
  adapter.onEvent({ type: 'question.asked', threadId: 't1', requestId: 'q1', questions: [] })
  const events = () => host.emitted.filter(([channel]) => channel === ProviderChannels.EVENT).map(([, e]) => e as RuntimeEvent)
  return { host, adapter, events }
}

describe('expired approvals and questions', () => {
  it('a provider that errors expires its open cards, with a reason, and refuses a late answer', async () => {
    const { host, adapter, events } = await started()
    adapter.onEvent({ type: 'status', threadId: 't1', status: 'error' })

    const expired = events().filter((e) => e.type === 'request.expired')
    expect(expired.map((e) => e.type === 'request.expired' && e.requestId)).toEqual(['r1', 'q1'])
    expect(expired.every((e) => e.type === 'request.expired' && e.reason.length > 0)).toBe(true)

    await expect(host.invoke(ProviderChannels.RESPOND_TO_REQUEST, 't1', 'r1', 'approve')).rejects.toThrow(REQUEST_EXPIRED)
    await expect(host.invoke(ProviderChannels.ANSWER_QUESTION, 't1', 'q1', [['yes']])).rejects.toThrow(REQUEST_EXPIRED)
    expect(adapter.responded).toEqual([])
  })

  it('an open card still reaches the provider', async () => {
    const { host, adapter } = await started()
    await host.invoke(ProviderChannels.RESPOND_TO_REQUEST, 't1', 'r1', 'approve')
    await host.invoke(ProviderChannels.ANSWER_QUESTION, 't1', 'q1', [['yes']])
    expect(adapter.responded).toEqual(['r1', 'q1'])
  })

  it('stopping the session expires its cards', async () => {
    const { host, events } = await started()
    await host.invoke(ProviderChannels.STOP_SESSION, 't1')
    expect(events().filter((e) => e.type === 'request.expired')).toHaveLength(2)
    await expect(host.invoke(ProviderChannels.RESPOND_TO_REQUEST, 't1', 'r1', 'deny')).rejects.toThrow(REQUEST_EXPIRED)
  })
})
