import { describe, expect, it, beforeEach, vi } from 'vitest'
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
}))

import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import type { BackendHost } from '../../src/main/backend/host'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent } from '../../src/shared/provider-events'
import { SESSION_START_STOPPED } from '../../src/shared/provider-events'

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
 * Stop while a session is still starting (cold Codex, a remote VM). The
 * adapter process is not registered until its start resolves, so a stop
 * used to find nothing to stop and the start went on to run the turn.
 */
class SlowAdapter implements ProviderAdapter {
  readonly provider = 'claude' as const
  release!: () => void
  readonly started = new Promise<void>((resolve) => {
    this.release = resolve
  })
  onEvent?: (e: RuntimeEvent) => void
  stopped: string[] = []
  interrupted: string[] = []

  async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    this.onEvent = onEvent
    await this.started
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
  async interruptTurn(threadId: string): Promise<void> {
    this.interrupted.push(threadId)
  }
  async stopSession(threadId: string): Promise<void> {
    this.stopped.push(threadId)
  }
  async setRuntimeMode(): Promise<void> {}
  async isAvailable(): Promise<boolean> {
    return true
  }
}

function setup() {
  const host = new FakeHost()
  const adapter = new SlowAdapter()
  const registry = new ProviderRegistry(host, new Map([['claude', adapter]]))
  registry.registerIpcHandlers()
  const start = host.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd: '/tmp' })
  return { host, adapter, start }
}

describe('Stop while a session is starting', () => {
  it('Stop during the start cancels the start and stops the new session', async () => {
    const { host, adapter, start } = setup()
    const startResult = start.then(
      () => 'started',
      (err: Error) => err.message,
    )
    await vi.waitFor(() => expect(adapter.onEvent).toBeDefined())

    expect(await host.invoke(ProviderChannels.INTERRUPT, 't1')).toEqual({ live: false })
    adapter.release()

    expect(await startResult).toContain(SESSION_START_STOPPED)
    expect(adapter.stopped).toEqual(['t1'])
    expect(adapter.interrupted).toEqual([])
    // Nothing is left running for a later Stop or turn to find.
    expect(await host.invoke(ProviderChannels.INTERRUPT, 't1')).toEqual({ live: false })
  })

  it('STOP_SESSION during the start waits for it and leaves no live session', async () => {
    const { host, adapter, start } = setup()
    start.catch(() => {})
    await vi.waitFor(() => expect(adapter.onEvent).toBeDefined())

    const stop = host.invoke(ProviderChannels.STOP_SESSION, 't1')
    adapter.release()
    await stop

    await expect(start).rejects.toThrow(SESSION_START_STOPPED)
    expect(adapter.stopped).toEqual(['t1'])
  })

  it('a start with no Stop is unaffected', async () => {
    const { adapter, start } = setup()
    adapter.release()
    await expect(start).resolves.toMatchObject({ threadId: 't1' })
    expect(adapter.stopped).toEqual([])
  })
})

describe('Stop reports whether a turn was live', () => {
  it('answers live: false when the backend has no running turn, so the client can clear a stale status', async () => {
    const { host, adapter, start } = setup()
    adapter.release()
    await start
    expect(await host.invoke(ProviderChannels.INTERRUPT, 't1')).toEqual({ live: false })
    expect(await host.invoke(ProviderChannels.INTERRUPT, 'unknown')).toEqual({ live: false })
  })

  it('answers live: true and interrupts while a turn runs', async () => {
    const { host, adapter, start } = setup()
    adapter.release()
    await start
    adapter.onEvent!({ type: 'status', threadId: 't1', status: 'running' })
    expect(await host.invoke(ProviderChannels.INTERRUPT, 't1')).toEqual({ live: true })
    expect(adapter.interrupted).toEqual(['t1'])
  })
})

describe('interruptFoundNoTurn', () => {
  it('is true only for an explicit live: false', async () => {
    const { interruptFoundNoTurn } = await import('../../src/shared/provider-events')
    expect(interruptFoundNoTurn({ live: false })).toBe(true)
    expect(interruptFoundNoTurn({ live: true })).toBe(false)
    // An older backend answers nothing: keep waiting for the closing event.
    expect(interruptFoundNoTurn(undefined)).toBe(false)
    expect(interruptFoundNoTurn(null)).toBe(false)
  })
})
