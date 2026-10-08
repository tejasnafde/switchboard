/**
 * Queued-message controls (list, promote, cancel) and the outstanding-turn
 * count they must keep right: a queued message counts as a turn when it is
 * accepted, so leaving the queue without a `turn.completed` of its own to
 * come (a cancel, or a promote into a turn it joins) must release it, and
 * nothing else may.
 */
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
    id, agentType: 'claude-code', displayName: id, enabled: true, env: {}, oauthDir: null,
  }),
  listOauthDirsForAgent: () => [],
}))

vi.mock('../../src/main/provider/remote-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/remote-gate')>()
  return { ...actual, remoteProviderLoginPrompt: () => null }
})

const rotated = new Map<string, string>([['rotated-uuid', 't1']])
const deleted: Array<[string, string]> = []

vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: () => {},
  recordConversationSegment: () => {},
  updateConversationSessionId: () => {},
  saveMessageIfAbsent: () => true,
  deleteUserMessage: (conversationId: string, messageId: string) => { deleted.push([conversationId, messageId]); return true },
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
import type { ProviderAdapter, ProviderKind, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent, UserTurnSubmissionV1 } from '../../src/shared/provider-events'
import type { QueuedTurnActionResult, QueuedTurnSummary, TurnDelivery } from '../../src/shared/turn-delivery'
import type { AtomicUserTurnContext } from '../../src/main/provider/durable-turn-acceptance'
import type { QueuedTurnRowStore } from '../../src/main/db/queued-turn-rows'

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

/** Holds a `queue` send while a turn runs, like the real adapters. */
class QueueingAdapter implements ProviderAdapter {
  private onEvent: (e: RuntimeEvent) => void = () => {}
  running = false
  held: string[] = []
  constructor(readonly provider: ProviderKind) {}

  async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    this.onEvent = onEvent
    return { threadId: opts.threadId, provider: this.provider, status: 'idle', runtimeMode: 'sandbox', cwd: opts.cwd, createdAt: 0 }
  }
  async sendTurn(threadId: string, _m: string, _r?: unknown, _i?: unknown, delivery?: TurnDelivery, queuedId?: string): Promise<void> {
    if (delivery === 'queue' && this.running && queuedId) {
      this.held.push(queuedId)
      this.onEvent({ type: 'turn.queued', threadId, messageId: queuedId })
      return
    }
    this.running = true
  }
  async cancelQueuedTurn(threadId: string, queuedId: string): Promise<boolean> {
    if (!this.take(queuedId)) return false
    this.onEvent({ type: 'turn.dequeued', threadId, messageId: queuedId, reason: 'cancelled' })
    return true
  }
  async promoteQueuedTurn(threadId: string, queuedId: string): Promise<boolean> {
    if (!this.take(queuedId)) return false
    this.onEvent({ type: 'turn.dequeued', threadId, messageId: queuedId, reason: 'promoted' })
    return true
  }
  emit(event: RuntimeEvent): void {
    this.onEvent(event)
  }
  /** The running turn ends; the oldest held message starts as its own. */
  finishTurn(threadId: string): void {
    this.onEvent({ type: 'turn.completed', threadId })
    const next = this.held.shift()
    if (next) this.onEvent({ type: 'turn.dequeued', threadId, messageId: next, reason: 'started' })
    else this.running = false
  }
  private take(id: string): boolean {
    const index = this.held.indexOf(id)
    if (index < 0) return false
    this.held.splice(index, 1)
    return true
  }
  async respondToRequest(): Promise<void> {}
  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async setRuntimeMode(): Promise<void> {}
  async isAvailable(): Promise<boolean> {
    return true
  }
}

/** Runs the registry's own prepare + dispatch, without the SQLite acceptance store. */
const passThroughSubmission = {
  async submit(input: UserTurnSubmissionV1, context: AtomicUserTurnContext) {
    await context.prepare()
    await context.dispatch(context.finalize ? await context.finalize(input) : input)
    return { status: 'accepted' as const, accepted: true as const, duplicate: false, state: 'completed' as const, acceptedAt: 1 }
  },
}

/** Records what the registry asks of the queued-row store. */
function fakeRowStore(earlier: string[] = []) {
  const calls: string[] = []
  const store: QueuedTurnRowStore = {
    record: (row) => { calls.push(`record ${row.messageId} ${row.conversationId} ${row.text}`) },
    forget: (id) => { calls.push(`forget ${id}`) },
    markNotSent: (id, cause) => {
      calls.push(`notSent ${id} ${cause}`)
      return { conversationId: 't1', messageId: id, content: `Error: not sent ${id}` }
    },
    sweepEarlierLaunches: () => {
      calls.push('sweep')
      return earlier.map((id) => ({ conversationId: 't1', messageId: id, content: `Error: not sent ${id}` }))
    },
  }
  return { store, calls }
}

async function setup(provider: ProviderKind, rows = fakeRowStore()) {
  const host = new FakeHost()
  const adapter = new QueueingAdapter(provider)
  const registry = new ProviderRegistry(host, new Map([[provider, adapter]]), undefined, passThroughSubmission, undefined, undefined, rows.store)
  registry.registerIpcHandlers()
  await host.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider, cwd: '/tmp' })
  const published: RuntimeEvent[] = []
  registry.bus.subscribe((e) => published.push(e))
  const submit = (origin: string, delivery?: TurnDelivery) => host.invoke(ProviderChannels.SUBMIT_USER_TURN, {
    version: 1, threadId: 't1', origin, providerText: `text of ${origin}`, ...(delivery ? { delivery } : {}),
  })
  const outstanding = () => (Reflect.get(registry, 'outstandingTurns') as Map<string, number>).get('t1') ?? 0
  const list = () => host.invoke<QueuedTurnSummary[]>(ProviderChannels.LIST_QUEUED_TURNS, 't1')
  const promote = (id: string) => host.invoke<QueuedTurnActionResult>(ProviderChannels.PROMOTE_QUEUED_TURN, 't1', id)
  const cancel = (id: string) => host.invoke<QueuedTurnActionResult>(ProviderChannels.CANCEL_QUEUED_TURN, 't1', id)
  return { host, adapter, registry, published, submit, outstanding, list, promote, cancel }
}

describe('ProviderRegistry queued messages', () => {
  beforeEach(() => {
    deleted.length = 0
  })

  it('lists a held message with its text, and announces it that way', async () => {
    const t = await setup('claude')
    await t.submit('a')
    await t.submit('b', 'queue')
    const [listed] = await t.list()
    expect(listed).toMatchObject({ threadId: 't1', messageId: 'remote_b', text: 'text of b' })
    expect(t.published.find((e) => e.type === 'turn.queued')).toMatchObject({ messageId: 'remote_b', text: 'text of b' })
    expect(await t.host.invoke(ProviderChannels.LIST_QUEUED_TURNS, 'rotated-uuid')).toHaveLength(1)
  })

  it('releases the count of a cancelled message and deletes its stored row', async () => {
    const t = await setup('claude')
    await t.submit('a')
    await t.submit('b', 'queue')
    expect(t.outstanding()).toBe(2)
    const result = await t.cancel('remote_b')
    expect(result).toMatchObject({ ok: true, turn: { messageId: 'remote_b', text: 'text of b' } })
    expect(t.outstanding()).toBe(1)
    expect(deleted).toEqual([['t1', 'remote_b']])
    expect(await t.list()).toEqual([])
    t.adapter.finishTurn('t1')
    expect(t.outstanding()).toBe(0)
  })

  it('releases the count of a promoted Claude message, whose steer joins the running turn', async () => {
    const t = await setup('claude')
    await t.submit('a')
    await t.submit('b', 'queue')
    expect(await t.promote('remote_b')).toMatchObject({ ok: true })
    expect(t.outstanding()).toBe(1)
    expect(deleted).toEqual([])
  })

  it('releases the count of a promoted Codex message, whose steer joins the running turn', async () => {
    const t = await setup('codex')
    await t.submit('a')
    await t.submit('b', 'queue')
    expect(t.outstanding()).toBe(2)
    expect(await t.promote('remote_b')).toMatchObject({ ok: true })
    expect(t.outstanding()).toBe(1)
    t.adapter.finishTurn('t1')
    expect(t.outstanding()).toBe(0)
  })

  it('keeps the count of a message that drains as its own turn, settled by its turn.completed', async () => {
    const t = await setup('claude')
    await t.submit('a')
    await t.submit('b', 'queue')
    t.adapter.finishTurn('t1')
    expect(t.outstanding()).toBe(1)
    expect(await t.list()).toEqual([])
    expect(await t.cancel('remote_b')).toMatchObject({ ok: false, reason: 'not-found' })
    expect(t.outstanding()).toBe(1)
    t.adapter.finishTurn('t1')
    expect(t.outstanding()).toBe(0)
  })

  it('counts a late steer that runs as its own turn ahead of a queued message', async () => {
    const t = await setup('claude')
    await t.submit('a')
    await t.submit('steer')
    await t.submit('b', 'queue')
    expect(t.outstanding()).toBe(2)
    t.adapter.emit({ type: 'turn.completed', threadId: 't1' })
    // The steer missed turn a and runs next; b is still waiting and counted.
    t.adapter.emit({ type: 'status', threadId: 't1', status: 'running', newTurn: true })
    expect(t.outstanding()).toBe(2)
    t.adapter.finishTurn('t1')
    // The steer's turn ended; b runs and is still counted.
    expect(t.outstanding()).toBe(1)
    t.adapter.finishTurn('t1')
    expect(t.outstanding()).toBe(0)
  })

  it('refuses to promote on a provider that cannot steer, and says why', async () => {
    const t = await setup('opencode')
    await t.submit('a')
    await t.submit('b', 'queue')
    const result = await t.promote('remote_b')
    expect(result).toMatchObject({ ok: false, reason: 'unsupported' })
    expect(result.ok === false && result.message).toMatch(/OpenCode/)
    expect(t.outstanding()).toBe(2)
    expect(await t.cancel('remote_b')).toMatchObject({ ok: true })
    expect(t.outstanding()).toBe(1)
  })

  it('does nothing for a message it does not hold', async () => {
    const t = await setup('claude')
    await t.submit('a')
    expect(await t.promote('remote_zzz')).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await t.cancel('remote_zzz')).toMatchObject({ ok: false, reason: 'not-found' })
    expect(t.outstanding()).toBe(1)
  })

  it('does not release a count twice when an adapter repeats a dequeue', async () => {
    const t = await setup('claude')
    await t.submit('a')
    await t.submit('b', 'queue')
    await t.cancel('remote_b')
    ;(Reflect.get(t.adapter, 'onEvent') as (e: RuntimeEvent) => void)({ type: 'turn.dequeued', threadId: 't1', messageId: 'remote_b', reason: 'cancelled' })
    expect(t.outstanding()).toBe(1)
  })

  it('turns a message that left the queue without running into a not-sent row, and says so live', async () => {
    const rows = fakeRowStore()
    const t = await setup('claude', rows)
    await t.submit('a')
    await t.submit('b', 'queue')
    await t.submit('c', 'queue')
    t.adapter.finishTurn('t1')
    ;(Reflect.get(t.adapter, 'onEvent') as (e: RuntimeEvent) => void)({ type: 'turn.dequeued', threadId: 't1', messageId: 'remote_c', reason: 'dropped' })
    expect(rows.calls).toEqual([
      'sweep',
      'record remote_b t1 text of b',
      'record remote_c t1 text of c',
      'forget remote_b',
      'notSent remote_c stopped',
    ])
    expect(t.published).toContainEqual({ type: 'error', threadId: 't1', message: 'not sent remote_c' })
  })

  it('checks for messages an earlier launch left queued when it starts', async () => {
    const rows = fakeRowStore(['remote_old'])
    await setup('claude', rows)
    expect(rows.calls[0]).toBe('sweep')
  })
})

describe('ProviderRegistry diff-card baseline', () => {
  it('keeps the running turn baseline for a queued send, and hands tool writes and queued starts to the tracker', async () => {
    const t = await setup('claude')
    const tracker = Reflect.get(t.registry, 'checkpoints') as {
      beginTurn: (...args: unknown[]) => Promise<void>
      noteToolStarted: (...args: unknown[]) => void
      noteToolCompleted: (...args: unknown[]) => void
      startQueuedTurn: (...args: unknown[]) => void
    }
    const begin = vi.spyOn(tracker, 'beginTurn').mockResolvedValue()
    const started = vi.spyOn(tracker, 'noteToolStarted')
    const completed = vi.spyOn(tracker, 'noteToolCompleted')
    const queuedStart = vi.spyOn(tracker, 'startQueuedTurn')
    await t.submit('a')
    await t.submit('b', 'queue')
    expect(begin.mock.calls.map((c) => c[2])).toEqual([false, true])

    const emit = Reflect.get(t.adapter, 'onEvent') as (e: RuntimeEvent) => void
    emit({ type: 'tool.started', threadId: 't1', toolId: 'x', toolName: 'Edit', input: { file_path: 'a.ts' } })
    emit({ type: 'tool.completed', threadId: 't1', toolId: 'x', writtenPaths: ['b.ts'] })
    emit({ type: 'turn.dequeued', threadId: 't1', messageId: 'remote_b', reason: 'started' })
    expect(started).toHaveBeenCalledWith('t1', 'x', 'Edit', { file_path: 'a.ts' })
    expect(completed).toHaveBeenCalledWith('t1', 'x', ['b.ts'])
    expect(queuedStart).toHaveBeenCalledWith('t1')
  })
})
