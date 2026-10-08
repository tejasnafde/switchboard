/**
 * A runtime mode applied from any client is saved on the conversation and
 * announced on `session.provider`, so the desktop's picker and every phone's
 * follow it. A turn that carries no mode leaves the chat's mode alone.
 */
import { describe, expect, it, vi } from 'vitest'
import './helpers/registry-session-mocks'

const { spans } = vi.hoisted(() => ({ spans: [] as Array<{ name: string; end: ReturnType<typeof vi.fn> }> }))
vi.mock('../../src/main/perf', () => ({ perfSpan: (name: string) => {
  const span = { name, end: vi.fn() }
  spans.push(span)
  return span
} }))

vi.mock('../../src/main/db/provider-instances', () => ({
  resolveProviderInstance: (agentType: string, id?: string) => ({
    id: id ?? 'work', agentType, displayName: 'Work', enabled: true, env: {}, oauthDir: null,
  }),
  getProviderInstanceFull: (id: string) => ({
    id, agentType: 'claude-code', displayName: 'Work', enabled: true, env: {}, oauthDir: null,
  }),
  listOauthDirsForAgent: () => [],
}))

vi.mock('../../src/main/provider/remote-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/remote-gate')>()
  return { ...actual, remoteProviderLoginPrompt: () => null }
})

const savedModes: Array<[string, string]> = []

vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: () => {},
  recordConversationSegment: () => {},
  updateConversationSessionId: () => {},
  saveMessageIfAbsent: () => true,
  deleteUserMessage: () => true,
  getConversationById: (id: string) => ({ id }),
  getConversationTitle: () => null,
  resolveRootThreadId: (id: string) => id,
  getConversationRuntimeMode: () => null,
  setConversationRuntimeMode: (id: string, mode: string) => { savedModes.push([id, mode]) },
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

import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import type { BackendHost } from '../../src/main/backend/host'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent, RuntimeMode, UserTurnSubmissionV1 } from '../../src/shared/provider-events'
import type { TurnDelivery } from '../../src/shared/turn-delivery'
import type { AtomicUserTurnContext, AtomicUserTurnSubmission } from '../../src/main/provider/durable-turn-acceptance'

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

/**
 * Holds a mode the way the real adapters do: set by setRuntimeMode or by a
 * turn that carries one. A `queue` send while a turn runs is held, and its
 * mode applies only when it starts (turn.dequeued 'started', then the mode).
 */
class ModeAdapter implements ProviderAdapter {
  readonly provider = 'claude' as const
  mode: RuntimeMode = 'full-access'
  running = false
  sendError: Error | undefined
  private held: Array<{ id: string; mode?: RuntimeMode }> = []
  private onEvent: (e: RuntimeEvent) => void = () => {}
  async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    this.onEvent = onEvent
    return { threadId: opts.threadId, provider: 'claude', status: 'idle', runtimeMode: this.mode, cwd: opts.cwd, createdAt: 0 }
  }
  async sendTurn(threadId: string, _message: string, runtimeMode?: RuntimeMode, _images?: unknown, delivery?: TurnDelivery, queuedId?: string): Promise<void> {
    if (this.sendError) throw this.sendError
    if (delivery === 'queue' && this.running && queuedId) {
      this.held.push({ id: queuedId, mode: runtimeMode })
      this.onEvent({ type: 'turn.queued', threadId, messageId: queuedId })
      return
    }
    if (runtimeMode) this.mode = runtimeMode
  }
  async cancelQueuedTurn(threadId: string, queuedId: string): Promise<boolean> {
    this.held = this.held.filter((t) => t.id !== queuedId)
    this.onEvent({ type: 'turn.dequeued', threadId, messageId: queuedId, reason: 'cancelled' })
    return true
  }
  finishTurn(threadId: string): void {
    this.onEvent({ type: 'turn.completed', threadId })
    const next = this.held.shift()
    if (!next) return
    this.onEvent({ type: 'turn.dequeued', threadId, messageId: next.id, reason: 'started' })
    if (next.mode) this.mode = next.mode
  }
  emitContent(threadId: string): void {
    this.onEvent({ type: 'content', threadId, streamKind: 'assistant', text: 'reply', append: true })
  }
  runtimeModeOf(): RuntimeMode {
    return this.mode
  }
  async setRuntimeMode(_threadId: string, mode: RuntimeMode): Promise<void> {
    this.mode = mode
  }
  async respondToRequest(): Promise<void> {}
  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async isAvailable(): Promise<boolean> {
    return true
  }
}

const passThroughSubmission = {
  async submit(_input: UserTurnSubmissionV1, context: AtomicUserTurnContext) {
    await context.prepare()
    await context.dispatch()
    return { status: 'accepted' as const, accepted: true as const, duplicate: false, state: 'completed' as const, acceptedAt: 1 }
  },
}

async function setup(submission: Pick<AtomicUserTurnSubmission, 'submit'> = passThroughSubmission) {
  spans.length = 0
  savedModes.length = 0
  const host = new FakeHost()
  const adapter = new ModeAdapter()
  const registry = new ProviderRegistry(host, new Map([['claude', adapter]]), undefined, submission)
  registry.registerIpcHandlers()
  await host.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd: '/tmp' })
  const published: RuntimeEvent[] = []
  registry.bus.subscribe((e) => published.push(e))
  const submit = (origin: string, runtimeMode?: RuntimeMode, delivery?: TurnDelivery) => host.invoke(ProviderChannels.SUBMIT_USER_TURN, {
    version: 1, threadId: 't1', origin, providerText: 'hi', ...(runtimeMode ? { runtimeMode } : {}), ...(delivery ? { delivery } : {}),
  })
  const announced = () => published.flatMap((e) => (e.type === 'session.provider' && e.runtimeMode ? [e] : []))
  return { host, adapter, submit, announced }
}

describe('runtime mode sync across clients', () => {
  it('a turn with no mode keeps a full-access chat in full access and announces nothing', async () => {
    const t = await setup()
    await t.submit('phone-1')
    expect(t.adapter.mode).toBe('full-access')
    expect(t.announced()).toEqual([])
    expect(savedModes).toEqual([])
  })

  it('a mode set from a phone is saved and announced with the thread identity', async () => {
    const t = await setup()
    await t.host.invoke(ProviderChannels.SET_RUNTIME_MODE, 't1', 'auto')
    expect(t.adapter.mode).toBe('auto')
    expect(savedModes).toEqual([['t1', 'auto']])
    expect(t.announced()).toEqual([
      { type: 'session.provider', threadId: 't1', provider: 'claude', instanceId: 'work', instanceName: 'Work', runtimeMode: 'auto' },
    ])
  })

  it('a turn carrying a different mode announces it, the same mode does not', async () => {
    const t = await setup()
    await t.submit('old-apk', 'sandbox')
    expect(t.announced().map((e) => e.runtimeMode)).toEqual(['sandbox'])
    await t.submit('again', 'sandbox')
    expect(t.announced()).toHaveLength(1)
    expect(savedModes).toEqual([['t1', 'sandbox']])
  })

  it('a queued message announces its mode only when it starts, and a cancelled one never', async () => {
    const t = await setup()
    t.adapter.running = true
    await t.submit('later', 'plan', 'queue')
    expect(t.adapter.mode).toBe('full-access')
    expect(t.announced()).toEqual([])
    expect(savedModes).toEqual([])
    t.adapter.finishTurn('t1')
    expect(t.announced().map((e) => e.runtimeMode)).toEqual(['plan'])
    expect(savedModes).toEqual([['t1', 'plan']])

    await t.submit('dropped', 'auto', 'queue')
    await t.host.invoke(ProviderChannels.CANCEL_QUEUED_TURN, 't1', 'remote_dropped')
    t.adapter.finishTurn('t1')
    expect(t.announced().map((e) => e.runtimeMode)).toEqual(['plan'])
  })

  it('a queue send that runs at once is announced like any turn', async () => {
    const t = await setup()
    await t.submit('idle', 'auto', 'queue')
    expect(t.announced().map((e) => e.runtimeMode)).toEqual(['auto'])
  })

  it('a mode set with no live session is still saved', async () => {
    const t = await setup()
    await t.host.invoke(ProviderChannels.SET_RUNTIME_MODE, 'not-started', 'plan')
    expect(savedModes).toEqual([['not-started', 'plan']])
    expect(t.announced()).toEqual([])
  })

  it('refuses a mode that is not one', async () => {
    const t = await setup()
    await expect(t.host.invoke(ProviderChannels.SET_RUNTIME_MODE, 't1', 'yolo')).rejects.toThrow('Unknown runtime mode')
  })
})

describe('first-content timing ownership', () => {
  it.each(['rejected', 'throw'] as const)('keeps the first span when a second atomic submission fails (%s)', async (failure) => {
    let calls = 0
    const t = await setup({
      async submit(input, context) {
        if (++calls === 1) return passThroughSubmission.submit(input, context)
        if (failure === 'throw') throw new Error('second submission failed')
        return { status: 'rejected', accepted: false, state: 'rejected', duplicate: false, retryable: false, reason: 'second submission rejected' }
      },
    })
    await t.submit('first')
    const span = spans.find((s) => s.name === 'turn.first-content')!
    if (failure === 'throw') await expect(t.submit('second')).rejects.toThrow('second submission failed')
    else await t.submit('second')
    expect(span.end).not.toHaveBeenCalled()
    t.adapter.emitContent('t1')
    expect(span.end).toHaveBeenCalledExactlyOnceWith({ outcome: 'content' })
  })
  it('keeps the first span when a second originless send throws', async () => {
    const t = await setup()
    await t.host.invoke(ProviderChannels.SEND_TURN, 't1', 'first')
    const span = spans.find((s) => s.name === 'turn.first-content')!
    t.adapter.sendError = new Error('second send failed')
    await expect(t.host.invoke(ProviderChannels.SEND_TURN, 't1', 'second')).rejects.toThrow('second send failed')
    expect(span.end).not.toHaveBeenCalled()
    t.adapter.emitContent('t1')
    expect(span.end).toHaveBeenCalledExactlyOnceWith({ outcome: 'content' })
  })
  it('cancels its own failed send and measures a retry', async () => {
    const t = await setup()
    t.adapter.sendError = new Error('first send failed')
    await expect(t.host.invoke(ProviderChannels.SEND_TURN, 't1', 'first')).rejects.toThrow('first send failed')
    const first = spans.filter((s) => s.name === 'turn.first-content')[0]
    expect(first.end).toHaveBeenCalledExactlyOnceWith({ outcome: 'submission-error' })
    t.adapter.sendError = undefined
    await t.host.invoke(ProviderChannels.SEND_TURN, 't1', 'retry')
    t.adapter.emitContent('t1')
    const retry = spans.filter((s) => s.name === 'turn.first-content')[1]
    expect(retry.end).toHaveBeenCalledExactlyOnceWith({ outcome: 'content' })
  })
})
