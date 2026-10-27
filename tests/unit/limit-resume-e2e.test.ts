/**
 * Auto-resume end to end, in process: the real ProviderRegistry, LimitResumer
 * and SQLite `limit_resumes` table, a fake adapter, and a fake clock. The
 * limited turn ends are what the real Claude and Codex adapters make of the
 * frames in tests/fixtures/limit-classification-cases.json.
 */
import { createMigratedDb } from './helpers/test-db'
import './helpers/registry-session-mocks'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const usage = vi.hoisted(() => ({ reads: [] as string[], closedUntil: null as number | null }))
vi.mock('../../src/main/provider/usage', () => ({
  fetchInstanceUsage: async (instanceId: string) => {
    usage.reads.push(instanceId)
    const closed = usage.closedUntil !== null && Date.now() < usage.closedUntil
    return {
      instanceId,
      agentType: 'claude-code',
      status: 'ok',
      plan: null,
      account: null,
      windows: closed
        ? [
            {
              id: 's',
              label: '5-hour session',
              kind: 'session',
              usedPercent: 100,
              resetsAtMs: usage.closedUntil,
              windowMinutes: 300,
              severity: 'critical',
            },
          ]
        : [],
      overage: [],
      fetchedAtMs: Date.now(),
    }
  },
}))

import {
  addProject,
  archiveConversation,
  createConversation,
  getLimitResume,
  setSetting,
} from '../../src/main/db/database'
import { ClaudeAdapter } from '../../src/main/provider/adapters/claude-adapter'
import { CodexAdapter } from '../../src/main/provider/adapters/codex-adapter'
import { TurnWatchdog, StderrTail } from '../../src/main/provider/turn-watchdog'
import { ProviderRegistry, notifyConversationArchived } from '../../src/main/provider/provider-registry'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import { LIMIT_RESUME_FIRE_DELAY_MS, limitResumeTurn, type TurnLimit } from '../../src/shared/limit-resume'
import type { BackendHost } from '../../src/main/backend/host'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent } from '../../src/shared/provider-events'
import { stripSenderLine } from '../../src/shared/sender-line'
import type { TurnDelivery } from '../../src/shared/turn-delivery'

interface Case {
  name: string
  provider: string
  events: object[]
  expected: { limitClass: string; resetAt: number | null }
}
const { cases } = JSON.parse(readFileSync(join(__dirname, '../fixtures/limit-classification-cases.json'), 'utf8')) as {
  cases: Case[]
}
// Any folder that exists on every OS: START_SESSION checks the cwd is readable.
const TMP = process.cwd()
const fixture = (name: string) => cases.find((c) => c.name === name)!

/** The `limit` the real adapter puts on the turn end for these frames. */
function classify(provider: 'claude' | 'codex', frames: object[]): TurnLimit | undefined {
  const events: RuntimeEvent[] = []
  const onEvent = (e: RuntimeEvent) => events.push(e)
  if (provider === 'claude') {
    const active = {
      session: {
        threadId: 'x',
        provider: 'claude',
        status: 'running',
        runtimeMode: 'sandbox',
        cwd: TMP,
        createdAt: 0,
      },
      query: null,
      prompt: { push: vi.fn(), close: vi.fn(), pendingMessages: () => [], answered: vi.fn() },
      onEvent,
      abortController: new AbortController(),
      pendingApprovals: new Map(),
      pendingQuestions: new Map(),
      currentMessageId: null,
      currentReasoningMessageId: null,
      partialMessageText: new Map<string, string>(),
      turnStartedAt: Date.now(),
      queuedTurns: [],
      skills: [],
      lastKnownModel: null,
      watchdog: new TurnWatchdog(180_000, () => {}),
      stderrTail: new StderrTail(2_000),
    }
    const adapter = new ClaudeAdapter()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const frame of frames) (adapter as any).handleSDKMessage('x', active, frame)
  } else {
    const active = {
      session: { threadId: 'x', provider: 'codex', status: 'running' },
      onEvent,
      stoppedTurnIds: new Set<string>(),
      activeTurnId: 'turn-1',
      turnStartPromise: null,
      turnStartedAt: Date.now(),
      assistantMessageText: new Map(),
      toolOutputText: new Map(),
      queuedTurns: [],
      queueHeld: false,
    }
    const adapter = new CodexAdapter()
    const end = { method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'failed' } } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const frame of [...frames, end]) (adapter as any).handleNotification('x', active, frame)
  }
  return events.filter((e) => e.type === 'turn.completed').at(-1)?.limit
}

/** The Claude rejection fixture with its reset moved to `resetAt`. */
const claudeLimitAt = (resetAt: number) =>
  classify('claude', [
    {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(resetAt / 1000) },
    },
  ])

class FakeHost implements BackendHost {
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  emitted: RuntimeEvent[] = []
  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn)
  }
  on(): void {}
  emit(channel: string, event: unknown): void {
    if (channel === ProviderChannels.EVENT) this.emitted.push(event as RuntimeEvent)
  }
  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    const fn = this.handlers.get(channel)
    if (!fn) throw new Error(`no handler registered for ${channel}`)
    return (await fn(...args)) as T
  }
}

/**
 * A provider with a queue: a message sent while a turn runs waits, a limited
 * end holds the queue until it is resumed, and a free queue starts its next
 * message in order when a turn ends.
 */
class FakeAdapter implements ProviderAdapter {
  onEvent!: (e: RuntimeEvent) => void
  started: string[] = []
  queue: Array<{ id: string; text: string }> = []
  running = false
  held = false
  interrupts = 0
  constructor(readonly provider: 'claude' | 'codex') {}
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
  async sendTurn(
    threadId: string,
    text: string,
    _mode?: unknown,
    _images?: unknown,
    delivery?: TurnDelivery,
    queuedId?: string,
  ): Promise<void> {
    if (delivery === 'queue' && this.running && queuedId) {
      this.queue.push({ id: queuedId, text: stripSenderLine(text) })
      this.onEvent({ type: 'turn.queued', threadId, messageId: queuedId })
      return
    }
    this.start(threadId, stripSenderLine(text))
  }
  private start(threadId: string, message: string, queuedId?: string): void {
    this.running = true
    this.started.push(message)
    if (queuedId) this.onEvent({ type: 'turn.dequeued', threadId, messageId: queuedId, reason: 'started' })
    this.onEvent({ type: 'status', threadId, status: 'running' })
  }
  /** The running turn ends, on `limit` or normally, with the events in the order the real adapters send them. */
  end(threadId: string, limit?: TurnLimit): void {
    this.running = false
    if (limit) {
      this.held = true
      this.onEvent({ type: 'turn.queue-held', threadId, held: true, reason: 'limit' })
      this.onEvent({ type: 'turn.completed', threadId, limit })
      this.onEvent({ type: 'status', threadId, status: 'error' })
      return
    }
    const next = this.held ? undefined : this.queue.shift()
    if (next) this.start(threadId, next.text, next.id)
    this.onEvent({ type: 'turn.completed', threadId })
    if (!next) this.onEvent({ type: 'status', threadId, status: 'idle' })
  }
  async resumeQueuedTurns(): Promise<boolean> {
    this.held = false
    return this.queue.length > 0
  }
  async respondToRequest(): Promise<void> {}
  async interruptTurn(): Promise<void> {
    this.interrupts++
  }
  async stopSession(): Promise<void> {}
  async setRuntimeMode(): Promise<void> {}
  async isAvailable(): Promise<boolean> {
    return true
  }
}

const MIN = 60_000

let host: FakeHost
let adapter: FakeAdapter
let registry: ProviderRegistry

function boot(provider: 'claude' | 'codex' = 'claude') {
  host = new FakeHost()
  adapter = new FakeAdapter(provider)
  registry = new ProviderRegistry(
    host,
    new Map([[provider, adapter]]),
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
}

async function startChat(provider: 'claude' | 'codex' = 'claude', threadId = 'c1') {
  await host.invoke(ProviderChannels.START_SESSION, { threadId, provider, cwd: TMP })
}

const send = (text: string, delivery?: 'queue') =>
  host.invoke(ProviderChannels.SUBMIT_USER_TURN, {
    version: 1,
    threadId: 'c1',
    origin: text,
    providerText: text,
    delivery,
  })
const queued = () => adapter.queue.map((q) => q.text)
const outstanding = () => (Reflect.get(registry, 'outstandingTurns') as Map<string, number>).get('c1') ?? 0
const limitState = () => host.invoke(ProviderChannels.LIMIT_RESUME_GET, 'c1')
const resumeTurns = () => adapter.started.filter((m) => m === limitResumeTurn()).length

/** Run a turn that ends on `limit`, with two messages queued behind it. */
async function limitedTurnWithQueue(limit: TurnLimit | undefined) {
  await send('work')
  await send('first queued', 'queue')
  await send('second queued', 'queue')
  adapter.end('c1', limit)
}

beforeEach(() => {
  vi.useFakeTimers()
  createMigratedDb()
  setSetting('labs.limit_auto_resume', 'true')
  addProject(TMP, 'tmp')
  createConversation('c1', TMP, 'claude-code')
  usage.reads = []
  usage.closedUntil = null
})

afterEach(async () => {
  await registry?.stopAll()
  vi.useRealTimers()
})

describe('auto-resume end to end', () => {
  it.each([
    ['claude', 'claude rate_limit_event rejected with a reset'],
    ['codex', 'gateway 503 with a reset time is a limit'],
  ] as const)('%s: arms, waits for the reset, resumes once, then runs the queue in order', async (provider, name) => {
    const { events, expected } = fixture(name)
    const resetAt = expected.resetAt!
    vi.setSystemTime(resetAt - 10 * MIN)
    boot(provider)
    await startChat(provider)

    const limit = classify(provider, events)
    expect(limit).toEqual({ limitClass: 'usage_limit', resetAt })
    await limitedTurnWithQueue(limit)

    expect(getLimitResume('c1')).toMatchObject({
      state: 'armed',
      resetAt,
      providerInstanceId: `${provider === 'claude' ? 'claude-code' : 'codex'}-default`,
    })
    expect(await limitState()).toEqual({ kind: 'armed', resetAt })

    // Not before the reset plus a minute.
    await vi.advanceTimersByTimeAsync(10 * MIN + LIMIT_RESUME_FIRE_DELAY_MS - 1_000)
    expect(resumeTurns()).toBe(0)
    expect(usage.reads).toEqual([])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(usage.reads).toHaveLength(1)
    expect(getLimitResume('c1')?.state).toBe('fired')
    expect(adapter.started).toEqual(['work', limitResumeTurn()])
    expect(await limitState()).toEqual({ kind: 'none' })

    // The held queue runs behind the resume turn, in the order it was sent.
    adapter.end('c1')
    adapter.end('c1')
    adapter.end('c1')
    expect(adapter.started).toEqual(['work', limitResumeTurn(), 'first queued', 'second queued'])

    // Nothing fires again.
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(resumeTurns()).toBe(1)
    expect(host.emitted.filter((e) => e.type === 'limit-resume.changed' && e.row)).toHaveLength(1)
  })

  it('counts the resume turn as its own turn, so the last held message still counts while it runs', async () => {
    const resetAt = Date.UTC(2026, 9, 27, 12, 0)
    vi.setSystemTime(resetAt - 5 * MIN)
    boot()
    await startChat()
    await limitedTurnWithQueue(claudeLimitAt(resetAt))
    expect(outstanding()).toBe(2)

    await vi.advanceTimersByTimeAsync(5 * MIN + LIMIT_RESUME_FIRE_DELAY_MS)
    expect(outstanding()).toBe(3)
    adapter.end('c1')
    adapter.end('c1')
    expect(adapter.started.at(-1)).toBe('second queued')
    expect(outstanding()).toBe(1)
    adapter.end('c1')
    expect(outstanding()).toBe(0)
  })

  it('a closed window at the reset re-arms to the reading reset, then resumes', async () => {
    const resetAt = Date.UTC(2026, 9, 27, 12, 0)
    vi.setSystemTime(resetAt - 5 * MIN)
    boot()
    await startChat()
    await limitedTurnWithQueue(claudeLimitAt(resetAt))

    usage.closedUntil = resetAt + 30 * MIN
    await vi.advanceTimersByTimeAsync(5 * MIN + LIMIT_RESUME_FIRE_DELAY_MS)
    expect(resumeTurns()).toBe(0)
    expect(getLimitResume('c1')).toMatchObject({ state: 'armed', resetAt: usage.closedUntil })

    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(resumeTurns()).toBe(1)
  })

  it.each([
    ['Stop', () => host.invoke(ProviderChannels.INTERRUPT, 'c1'), 'disarmed'],
    ['Cancel', () => host.invoke(ProviderChannels.LIMIT_RESUME_CANCEL, 'c1'), 'disarmed'],
    [
      'archive',
      async () => {
        archiveConversation('c1')
        notifyConversationArchived('c1')
      },
      'disarmed',
    ],
  ] as const)('%s disarms: nothing resumes at the reset', async (_label, act) => {
    const resetAt = Date.UTC(2026, 9, 27, 12, 0)
    vi.setSystemTime(resetAt - 5 * MIN)
    boot()
    await startChat()
    await limitedTurnWithQueue(claudeLimitAt(resetAt))
    expect(getLimitResume('c1')?.state).toBe('armed')

    await act()
    expect(getLimitResume('c1')?.state).toBe('disarmed')

    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(resumeTurns()).toBe(0)
    expect(queued()).toEqual(['first queued', 'second queued'])
  })

  it('a Stop between a Claude limit and its late empty result stays disarmed', async () => {
    const { events } = fixture('a limit followed by an empty success stays a limit')
    const limit = classify('claude', events)!
    vi.setSystemTime(limit.resetAt! - 5 * MIN)
    boot()
    await startChat()
    await limitedTurnWithQueue(limit)
    await host.invoke(ProviderChannels.INTERRUPT, 'c1')
    // The same turn's second end: same reset, moments later.
    adapter.onEvent({ type: 'turn.completed', threadId: 'c1', limit })
    expect(getLimitResume('c1')?.state).toBe('disarmed')
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(resumeTurns()).toBe(0)
  })

  it('gives up after three resumed turns that hit the limit again at once', async () => {
    let resetAt = Date.UTC(2026, 9, 27, 12, 0)
    vi.setSystemTime(resetAt - 5 * MIN)
    boot()
    await startChat()
    await limitedTurnWithQueue(claudeLimitAt(resetAt))

    for (let attempt = 1; attempt <= 3; attempt++) {
      await vi.advanceTimersByTimeAsync(resetAt + LIMIT_RESUME_FIRE_DELAY_MS - Date.now())
      expect(resumeTurns()).toBe(attempt)
      resetAt = Date.now() + 10 * MIN
      adapter.end('c1', claudeLimitAt(resetAt))
    }

    expect(getLimitResume('c1')).toMatchObject({ state: 'gave_up', streak: 3 })
    expect(await limitState()).toEqual({ kind: 'gave_up' })
    expect(host.emitted.some((e) => e.type === 'limit-resume.changed' && e.gaveUp)).toBe(true)
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(resumeTurns()).toBe(3)
    expect(queued()).toEqual(['first queued', 'second queued'])
  })

  it('a restart rebuilds the timer from the table and resumes once the chat runs under its session id', async () => {
    const resetAt = Date.UTC(2026, 9, 27, 12, 0)
    vi.setSystemTime(resetAt - 5 * MIN)
    boot()
    await startChat()
    // Claude names the session after the first turn; the next process resumes it by that id.
    adapter.onEvent({ type: 'session', threadId: 'c1', sessionId: 'claude-uuid' })
    await limitedTurnWithQueue(claudeLimitAt(resetAt))
    const before = adapter
    await registry.stopAll()

    // A new process: only the table survives.
    boot()
    expect(await limitState()).toEqual({ kind: 'armed', resetAt })
    // The chat is not running at the reset: the fire waits for its session.
    await vi.advanceTimersByTimeAsync(5 * MIN + LIMIT_RESUME_FIRE_DELAY_MS)
    expect(resumeTurns()).toBe(0)
    expect(getLimitResume('c1')?.state).toBe('armed')

    await startChat('claude', 'claude-uuid')
    await vi.advanceTimersByTimeAsync(0)
    expect(adapter.started).toEqual([limitResumeTurn()])
    expect(before.started).toEqual(['work'])
    expect(getLimitResume('c1')?.state).toBe('fired')
  })
})
