/**
 * Canary for card recovery: GET_PENDING_REQUESTS, what a reconnecting desktop
 * or phone reads back, never returns a live secret, even for an adapter card
 * or a stored approval card that held the value before it was saved.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
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

/** A Claude session's rotated UUID, mapped back to the chat's root id. */
const rotated = new Map<string, string>()

vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: () => {},
  recordConversationSegment: () => {},
  updateConversationSessionId: () => {},
  saveMessageIfAbsent: () => true,
  getConversationById: (id: string) => ({ id }),
  getConversationTitle: () => null,
  resolveRootThreadId: (id: string) => rotated.get(id) ?? id,
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
}))

vi.mock('../../src/main/db/secret-mask', async () => {
  const { secretRedactor } = await import('../../src/main/secrets/secret-redactor')
  const scope = (id: string) => [rotated.get(id) ?? id]
  return {
    secretScope: scope,
    armedSecretScope: (id: string) => (secretRedactor.armed(scope(id)) ? scope(id) : null),
    maskStoredText: (id: string, text: string | null) =>
      text === null ? null : (secretRedactor.redactText(scope(id), text) ?? text),
    maskStoredValue: <T>(id: string, value: T) => secretRedactor.redactDeep(scope(id), value).value,
  }
})

import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import { secretRedactor } from '../../src/main/secrets/secret-redactor'
import { memoryApprovalCardStore } from '../../src/shared/agent-approval-cards'
import type { AgentWritePlan } from '../../src/main/mcp/agent-approvals'
import type { BackendHost } from '../../src/main/backend/host'
import type { ProviderAdapter, ProviderKind, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent } from '../../src/shared/provider-events'

const CANARY = 'sbcanary_recovery_0123456789'

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

class RecordingAdapter implements ProviderAdapter {
  private onEvent: (e: RuntimeEvent) => void = () => {}
  calls: string[] = []
  failRespond = false
  constructor(readonly provider: ProviderKind) {}

  async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    this.onEvent = onEvent
    return {
      threadId: opts.threadId,
      provider: this.provider,
      status: 'idle',
      runtimeMode: 'sandbox',
      cwd: opts.cwd,
      createdAt: 0,
    }
  }
  emit(event: RuntimeEvent): void {
    this.onEvent(event)
  }
  async sendTurn(_t: string, message: string, _r?: unknown, _i?: unknown, delivery?: TurnDelivery): Promise<void> {
    this.calls.push(`send ${stripSenderLine(message)} ${delivery ?? 'default'}`)
  }
  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: ApprovalDecision,
    reason?: string,
  ): Promise<void> {
    if (this.failRespond) throw new Error('provider gone')
    this.calls.push(`respond ${requestId} ${decision} ${reason ?? '-'}`)
    this.onEvent({ type: 'request.closed', threadId, requestId, decision })
  }
  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async setRuntimeMode(): Promise<void> {}
  async isAvailable(): Promise<boolean> {
    return true
  }
}

class EmittingAdapter implements ProviderAdapter {
  readonly provider: ProviderKind = 'claude'
  private onEvent: (e: RuntimeEvent) => void = () => {}
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
  emit(event: RuntimeEvent): void {
    this.onEvent(event)
  }
  async sendTurn(): Promise<void> {}
  async respondToRequest(): Promise<void> {}
  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async setRuntimeMode(): Promise<void> {}
  async isAvailable(): Promise<boolean> {
    return true
  }
}

afterEach(() => secretRedactor.clear())

describe('GET_PENDING_REQUESTS and live secrets', () => {
  it('masks a stored card and an adapter card that held the value before it was saved', async () => {
    const store = memoryApprovalCardStore<AgentWritePlan>()
    store.putCard({
      requestId: 'sbapr_1_aa',
      chatId: 't1',
      threadId: 't1',
      toolName: 'mcp__switchboard__send_message',
      detail: `send ${CANARY}`,
      hostWrite: null,
      plan: { kind: 'peer-send', sessionId: 's2', message: CANARY },
      openedAt: Date.now(),
    })
    const host = new FakeHost()
    const adapter = new EmittingAdapter()
    const registry = new ProviderRegistry(host, new Map([['claude', adapter]]), undefined, undefined, null, store)
    registry.registerIpcHandlers()
    await host.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd: '/tmp' })
    adapter.emit({
      type: 'request.opened',
      threadId: 't1',
      requestId: 'r1',
      requestType: 'command',
      toolName: 'Bash',
      detail: `curl -H "Authorization: ${CANARY}"`,
    })
    const before = await host.invoke<unknown[]>(ProviderChannels.GET_PENDING_REQUESTS, 't1')
    expect(before).toHaveLength(2)
    expect(JSON.stringify(before)).toContain(CANARY)

    secretRedactor.add('t1', 'sec1', 'API_KEY', Buffer.from(CANARY))
    const after = await host.invoke<unknown[]>(ProviderChannels.GET_PENDING_REQUESTS, 't1')
    expect(after).toHaveLength(2)
    expect(JSON.stringify(after)).not.toContain(CANARY)
    expect(JSON.stringify(after)).toContain('[secret API_KEY]')
  })
})
