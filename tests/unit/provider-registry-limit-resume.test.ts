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

// A reading the runner cannot use counts as open.
vi.mock('../../src/main/provider/usage', () => ({
  fetchInstanceUsage: async () => ({ status: 'error', windows: [], overage: [] }),
}))

const rows = vi.hoisted(() => new Map<string, Record<string, unknown>>())
const saved = vi.hoisted(() => [] as string[])

vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: () => {},
  recordConversationSegment: () => {},
  updateConversationSessionId: () => {},
  saveMessageIfAbsent: (_id: string, _conv: string, role: string, content: string) => {
    saved.push(`${role}:${content}`)
    return true
  },
  getConversationById: (id: string) => ({ id }),
  getConversationTitle: () => null,
  resolveRootThreadId: (id: string) => id,
  getConversationRuntimeMode: () => null,
  getConversationModel: () => null,
  getConversationReasoningEffort: () => null,
  getConversationAgentType: () => null,
  getConversationProviderInstanceId: () => null,
  getSetting: (key: string) => (key === 'labs.limit_auto_resume' ? 'true' : null),
  getConversationExecutionRoot: () => null,
  commitConversationExecutionRoot: () => {},
  commitConversationProviderSwitch: () => {},
  getDb: () => ({}),
  deleteUserMessage: () => {},
  isConversationArchived: () => false,
  // limit_resumes, in memory: the SQL is covered by hub-db.test.ts.
  getLimitResume: (id: string) => rows.get(id) ?? null,
  listArmedLimitResumes: () => [...rows.values()].filter((r) => r.state === 'armed'),
  armLimitResume: (a: Record<string, unknown>) =>
    rows.set(a.conversationId as string, { streak: 0, ...rows.get(a.conversationId as string), ...a, state: 'armed' }),
  disarmLimitResume: () => false,
  markLimitResumeFired: (id: string, requestId: string) => {
    const row = rows.get(id)
    if (row?.state !== 'armed' || row.requestId !== requestId) return false
    row.state = 'fired'
    return true
  },
  setLimitResumeStreak: () => {},
}))

import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import type { BackendHost } from '../../src/main/backend/host'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent } from '../../src/shared/provider-events'
import { limitResumeTurn, limitResumeMarker } from '../../src/shared/limit-resume'

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

class Adapter implements ProviderAdapter {
  readonly provider = 'claude' as const
  onEvent!: (e: RuntimeEvent) => void
  calls: string[] = []
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
  async sendTurn(
    _threadId: string,
    message: string,
    _mode?: unknown,
    _images?: unknown,
    delivery?: string,
  ): Promise<void> {
    this.calls.push(`send:${delivery ?? 'turn'}:${message}`)
  }
  async respondToRequest(): Promise<void> {}
  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async setRuntimeMode(): Promise<void> {}
  async isAvailable(): Promise<boolean> {
    return true
  }
  async resumeQueuedTurns(): Promise<boolean> {
    this.calls.push('resume-queue')
    return true
  }
}

describe('auto-resume in the registry', () => {
  it('arms on a limited turn end, then Resume now sends the resume turn before the held queue', async () => {
    const host = new FakeHost()
    const adapter = new Adapter()
    const registry = new ProviderRegistry(
      host,
      new Map([['claude', adapter]]),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    )
    registry.registerIpcHandlers()
    await host.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd: '/tmp' })
    // The running turn, and a message queued behind it: both counted as outstanding.
    adapter.onEvent({ type: 'status', threadId: 't1', status: 'running', newTurn: true })
    adapter.onEvent({ type: 'status', threadId: 't1', status: 'running', newTurn: true })
    adapter.onEvent({ type: 'turn.queued', threadId: 't1', messageId: 'm1', text: 'next', queuedAt: 1 })
    const resetAt = Date.now() + 120_000
    adapter.onEvent({ type: 'turn.completed', threadId: 't1', limit: { limitClass: 'usage_limit', resetAt } })
    adapter.onEvent({ type: 'turn.queue-held', threadId: 't1', held: true, reason: 'limit' })
    adapter.onEvent({ type: 'status', threadId: 't1', status: 'error' })

    expect(rows.get('t1')).toMatchObject({ state: 'armed', resetAt, providerInstanceId: 'claude-code-default' })
    expect(await host.invoke(ProviderChannels.LIMIT_RESUME_GET, 't1')).toEqual({ kind: 'armed', resetAt })

    expect(await host.invoke(ProviderChannels.LIMIT_RESUME_NOW, 't1')).toEqual({ ok: true })
    // Its own turn, not queued behind the held message, which follows it.
    expect(adapter.calls).toEqual([`send:turn:${limitResumeTurn()}`, 'resume-queue'])
    expect(saved).toContain(`system:${limitResumeMarker()}`)
    const events = host.emitted.filter(([c]) => c === ProviderChannels.EVENT).map(([, e]) => e as RuntimeEvent)
    expect(events.at(-1)).toMatchObject({
      type: 'limit-resume.changed',
      threadId: 't1',
      state: { kind: 'none' },
      row: { content: limitResumeMarker() },
    })
    registry.limitResumer?.dispose()
  })
})
