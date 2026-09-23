/**
 * Pending-approval recovery (see AGENTS.md "Question / Plan flow" for how a
 * plan is resolved without a closing event of its own).
 *
 * ProviderRegistry keeps its own record of a thread's still-open
 * request.opened / question.asked / plan.proposed cards, off the same event
 * path that updates sessionStatus. GET_PENDING_REQUESTS returns that record
 * so a client that reconnected after a resume gap, or reloaded, can recover a
 * card that will never arrive again as a live event.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'

vi.mock('../../src/main/db/providerInstances', () => ({
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

/** `rotated` -> the thread id GET_PENDING_REQUESTS is asked with resolves to
 *  the id the events were actually recorded under, mirroring the sidebar
 *  surfacing a Claude session's rotated UUID (see AGENTS.md's
 *  resolveRootThreadId gotcha). */
const rotated = new Map<string, string>([['rotated-uuid', 't1']])

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
import type { PendingBlockingEvent } from '../../src/shared/pending-requests'

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

/** Exposes `emit(threadId, event)` so a test can inject a runtime event
 *  directly, the way an adapter would from deep inside a live turn. */
class RecordingAdapter implements ProviderAdapter {
  readonly provider = 'claude' as const
  private onEventByThread = new Map<string, (e: RuntimeEvent) => void>()

  async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    this.onEventByThread.set(opts.threadId, onEvent)
    return {
      threadId: opts.threadId,
      provider: 'claude',
      status: 'idle',
      runtimeMode: opts.runtimeMode ?? 'sandbox',
      cwd: opts.cwd,
      createdAt: 0,
    }
  }

  emit(threadId: string, event: RuntimeEvent): void {
    this.onEventByThread.get(threadId)?.(event)
  }

  async sendTurn(): Promise<void> {}
  async respondToRequest(): Promise<void> {}
  async interruptTurn(): Promise<void> {}
  async stopSession(threadId: string): Promise<void> {
    this.onEventByThread.delete(threadId)
  }
  async setRuntimeMode(): Promise<void> {}
  async isAvailable(): Promise<boolean> {
    return true
  }
}

async function setup() {
  const host = new FakeHost()
  const adapter = new RecordingAdapter()
  const registry = new ProviderRegistry(host, new Map([['claude', adapter]]))
  registry.registerIpcHandlers()
  await host.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd: '/tmp' })
  const getPending = (threadId: string) =>
    host.invoke<PendingBlockingEvent[]>(ProviderChannels.GET_PENDING_REQUESTS, threadId)
  return { host, adapter, getPending }
}

describe('ProviderRegistry pending-request recovery', () => {
  beforeEach(() => {
    rotated.clear()
    rotated.set('rotated-uuid', 't1')
  })

  it('is empty for a thread with nothing open', async () => {
    const { getPending } = await setup()
    expect(await getPending('t1')).toEqual([])
  })

  it('records an approval on request.opened and returns the original event', async () => {
    const { adapter, getPending } = await setup()
    adapter.emit('t1', { type: 'request.opened', threadId: 't1', requestId: 'r1', requestType: 'command', toolName: 'Bash', detail: 'ls' })
    expect(await getPending('t1')).toEqual([
      { type: 'request.opened', threadId: 't1', requestId: 'r1', requestType: 'command', toolName: 'Bash', detail: 'ls' },
    ])
  })

  it('clears the approval on request.closed', async () => {
    const { adapter, getPending } = await setup()
    adapter.emit('t1', { type: 'request.opened', threadId: 't1', requestId: 'r1', requestType: 'command', toolName: 'Bash', detail: 'ls' })
    adapter.emit('t1', { type: 'request.closed', threadId: 't1', requestId: 'r1', decision: 'approve' })
    expect(await getPending('t1')).toEqual([])
  })

  it('records a question on question.asked and clears it on question.answered', async () => {
    const { adapter, getPending } = await setup()
    const questions = [{ id: 'q1', header: 'H', question: 'Pick one', options: [{ label: 'a' }], multiSelect: false }]
    adapter.emit('t1', { type: 'question.asked', threadId: 't1', requestId: 'q1', questions })
    expect(await getPending('t1')).toEqual([
      { type: 'question.asked', threadId: 't1', requestId: 'q1', questions },
    ])
    adapter.emit('t1', { type: 'question.answered', threadId: 't1', requestId: 'q1', answers: [['a']] })
    expect(await getPending('t1')).toEqual([])
  })

  it('records a plan on plan.proposed and survives the turn.completed that follows it', async () => {
    // ExitPlanMode is denied at once and the turn ends normally right after -
    // the plan is still awaiting the user's Implement/Iterate decision, so
    // turn.completed must not be what clears it (that would discard a plan
    // seconds after proposing it, long before a client could ever recover it).
    const { adapter, getPending } = await setup()
    adapter.emit('t1', { type: 'plan.proposed', threadId: 't1', planId: 'p1', planMarkdown: '# Plan' })
    adapter.emit('t1', { type: 'turn.completed', threadId: 't1' })
    expect(await getPending('t1')).toEqual([
      { type: 'plan.proposed', threadId: 't1', planId: 'p1', planMarkdown: '# Plan' },
    ])
  })

  it('clears a pending plan once the user actually responds with a new turn', async () => {
    const { adapter, host, getPending } = await setup()
    adapter.emit('t1', { type: 'plan.proposed', threadId: 't1', planId: 'p1', planMarkdown: '# Plan' })
    adapter.emit('t1', { type: 'turn.completed', threadId: 't1' })
    await host.invoke(ProviderChannels.SEND_TURN, 't1', 'please implement it')
    expect(await getPending('t1')).toEqual([])
  })

  it('an open approval survives a queued or steered send while the turn is still running', async () => {
    // The turnDepth-reset code path that clears a resolved plan also runs
    // for a Codex steer and for a delivery: 'queue' send, both of which
    // reach it while an earlier turn on this thread is still outstanding -
    // and that earlier turn can still be blocked on an open approval or
    // question. Only the plan may be cleared there; the approval must keep
    // waiting for its own request.closed.
    const { adapter, host, getPending } = await setup()
    adapter.emit('t1', {
      type: 'request.opened', threadId: 't1', requestId: 'r1', requestType: 'tool', toolName: 'Write', detail: 'x',
    })
    adapter.emit('t1', { type: 'plan.proposed', threadId: 't1', planId: 'p1', planMarkdown: '# Plan' })
    // First send starts a turn that never completes (RecordingAdapter.sendTurn
    // is a no-op), so the thread stays mid-turn for the second send below.
    await host.invoke(ProviderChannels.SEND_TURN, 't1', 'first message')
    // A second send while mid-turn - a steer on the legacy channel.
    await host.invoke(ProviderChannels.SEND_TURN, 't1', 'steer message')
    expect(await getPending('t1')).toEqual([
      { type: 'request.opened', threadId: 't1', requestId: 'r1', requestType: 'tool', toolName: 'Write', detail: 'x' },
    ])
  })

  it('clears every open card when the provider reports it died', async () => {
    const { adapter, getPending } = await setup()
    adapter.emit('t1', { type: 'request.opened', threadId: 't1', requestId: 'r1', requestType: 'tool', toolName: 'Write', detail: 'x' })
    adapter.emit('t1', { type: 'status', threadId: 't1', status: 'error' })
    expect(await getPending('t1')).toEqual([])
  })

  it('clears every open card on stop-session', async () => {
    const { adapter, host, getPending } = await setup()
    adapter.emit('t1', { type: 'question.asked', threadId: 't1', requestId: 'q1', questions: [] })
    await host.invoke(ProviderChannels.STOP_SESSION, 't1')
    expect(await getPending('t1')).toEqual([])
  })

  it('resolves the id through resolveRootThreadId, so a rotated session id still finds the record', async () => {
    const { adapter, getPending } = await setup()
    adapter.emit('t1', { type: 'plan.proposed', threadId: 't1', planId: 'p1', planMarkdown: '# Plan' })
    expect(await getPending('rotated-uuid')).toEqual([
      { type: 'plan.proposed', threadId: 't1', planId: 'p1', planMarkdown: '# Plan' },
    ])
  })
})
