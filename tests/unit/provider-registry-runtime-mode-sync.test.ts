/**
 * A runtime mode applied from any client is saved on the conversation and
 * announced on `session.provider`, so the desktop's picker and every phone's
 * follow it. A turn that carries no mode leaves the chat's mode alone.
 */
import { describe, expect, it, vi } from 'vitest'

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
import type { AtomicUserTurnContext } from '../../src/main/provider/durable-turn-acceptance'

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

/** Holds a mode the way the real adapters do: set by setRuntimeMode or by a turn that carries one. */
class ModeAdapter implements ProviderAdapter {
  readonly provider = 'claude' as const
  mode: RuntimeMode = 'full-access'
  async startSession(opts: SessionStartOpts): Promise<ProviderSession> {
    return { threadId: opts.threadId, provider: 'claude', status: 'idle', runtimeMode: this.mode, cwd: opts.cwd, createdAt: 0 }
  }
  async sendTurn(_threadId: string, _message: string, runtimeMode?: RuntimeMode): Promise<void> {
    if (runtimeMode) this.mode = runtimeMode
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

async function setup() {
  savedModes.length = 0
  const host = new FakeHost()
  const adapter = new ModeAdapter()
  const registry = new ProviderRegistry(host, new Map([['claude', adapter]]), undefined, passThroughSubmission)
  registry.registerIpcHandlers()
  await host.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd: '/tmp' })
  const published: RuntimeEvent[] = []
  registry.bus.subscribe((e) => published.push(e))
  const submit = (origin: string, runtimeMode?: RuntimeMode) => host.invoke(ProviderChannels.SUBMIT_USER_TURN, {
    version: 1, threadId: 't1', origin, providerText: 'hi', ...(runtimeMode ? { runtimeMode } : {}),
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
