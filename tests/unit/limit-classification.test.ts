/**
 * The Claude and Codex adapters classify every case of
 * tests/fixtures/limit-classification-cases.json on the turn's own end event.
 * The ACP case runs in acp-generic-adapter.test.ts, against a fake agent.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeAdapter } from '../../src/main/provider/adapters/claude-adapter'
import { CodexAdapter } from '../../src/main/provider/adapters/codex-adapter'
import { TurnWatchdog, StderrTail } from '../../src/main/provider/turn-watchdog'
import type { RuntimeEvent } from '../../src/shared/provider-events'
import { codexErrorLimit, mergeTurnLimit } from '../../src/shared/limit-resume'
import { reportedModel } from '../../src/shared/claude-rate-limit'

interface Case {
  name: string
  provider: string
  events: object[]
  expected: { limitClass: string; resetAt: number | null; model?: null; tokens?: number }
}
const { cases } = JSON.parse(readFileSync(join(__dirname, '../fixtures/limit-classification-cases.json'), 'utf8')) as {
  cases: Case[]
}

type TurnCompleted = Extract<RuntimeEvent, { type: 'turn.completed' }>
const lastTurnEnd = (events: RuntimeEvent[]) =>
  events.filter((e): e is TurnCompleted => e.type === 'turn.completed').at(-1)

function claudeActive(onEvent: (e: RuntimeEvent) => void) {
  return {
    session: {
      threadId: 't',
      provider: 'claude',
      status: 'running',
      runtimeMode: 'sandbox',
      cwd: '/tmp',
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
    lastKnownModel: null as string | null,
    watchdog: new TurnWatchdog(180_000, () => {}),
    stderrTail: new StderrTail(2_000),
  }
}

function codexActive(onEvent: (e: RuntimeEvent) => void) {
  return {
    session: { threadId: 't', provider: 'codex', status: 'running' },
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
}

describe('limit classification on the turn end event', () => {
  it.each(cases.filter((c) => c.provider === 'claude'))('claude: $name', ({ events: frames, expected }) => {
    const events: RuntimeEvent[] = []
    const active = claudeActive((e) => events.push(e))
    const adapter = new ClaudeAdapter()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const frame of frames) (adapter as any).handleSDKMessage('t', active, frame)
    const end = lastTurnEnd(events)
    expect(end?.limit?.limitClass ?? 'other').toBe(expected.limitClass)
    expect(end?.limit?.resetAt ?? null).toBe(expected.resetAt)
    if (expected.model === null) {
      expect(active.lastKnownModel).toBeNull()
      expect(JSON.stringify(events)).not.toContain('<synthetic>')
    }
    if (expected.tokens !== undefined) {
      const tokens = events.reduce((sum, e) => sum + (e.type === 'turn.completed' ? (e.usedTokens ?? 0) : 0), 0)
      expect(tokens).toBe(expected.tokens)
    }
  })

  it.each(cases.filter((c) => c.provider === 'codex'))('codex: $name', ({ events: frames, expected }) => {
    const events: RuntimeEvent[] = []
    const active = codexActive((e) => events.push(e))
    const adapter = new CodexAdapter()
    const turnEnd = { method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'failed' } } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const frame of [...frames, turnEnd]) (adapter as any).handleNotification('t', active, frame)
    const end = lastTurnEnd(events)
    expect(end?.limit?.limitClass ?? 'other').toBe(expected.limitClass)
    expect(end?.limit?.resetAt ?? null).toBe(expected.resetAt)
  })
})

describe('limit helpers', () => {
  it('codexErrorLimit reads a full context window, a 429 status object and an unparsed reset time', () => {
    expect(codexErrorLimit({ message: 'x', codexErrorInfo: 'contextWindowExceeded' })?.limitClass).toBe('context_full')
    expect(
      codexErrorLimit({ message: 'x', codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } })
        ?.limitClass,
    ).toBe('usage_limit')
    expect(codexErrorLimit({ message: 'stream disconnected', codexErrorInfo: 'serverOverloaded' })).toBeNull()
    expect(codexErrorLimit({ message: 'usage limit, try again at 3:40 PM' })).toEqual({
      limitClass: 'usage_limit',
      resetAt: null,
    })
  })

  it('keeps a usage limit over a later class in the same turn', () => {
    const limit = { limitClass: 'usage_limit', resetAt: 5 } as const
    expect(mergeTurnLimit(limit, { limitClass: 'context_full', resetAt: null })).toBe(limit)
    expect(mergeTurnLimit(null, null)).toBeNull()
  })

  it('never reports the synthetic model', () => {
    expect(reportedModel('<synthetic>')).toBeNull()
    expect(reportedModel('claude-opus-4-1')).toBe('claude-opus-4-1')
  })
})

describe('a limit stays on its own turn', () => {
  it('claude: the late empty result of a rejected turn does not end it twice', () => {
    const events: RuntimeEvent[] = []
    const active = claudeActive((e) => events.push(e))
    const adapter = new ClaudeAdapter()
    const { events: frames } = cases.find((c) => c.name === 'a limit followed by an empty success stays a limit')!
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const frame of frames) (adapter as any).handleSDKMessage('t', active, frame)
    expect(events.filter((e) => e.type === 'turn.completed')).toHaveLength(1)
  })

  it('claude: a rejection while idle carries no limit', () => {
    const events: RuntimeEvent[] = []
    const active = { ...claudeActive((e) => events.push(e)), turnStartedAt: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(new ClaudeAdapter() as any).handleSDKMessage('t', active, {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1761045600 },
    })
    expect(lastTurnEnd(events)?.limit).toBeUndefined()
  })

  it('codex: a late limit error of a stopped turn does not mark the running one', () => {
    const events: RuntimeEvent[] = []
    const active = codexActive((e) => events.push(e))
    const adapter = new CodexAdapter()
    const frames = [
      {
        method: 'error',
        params: { turnId: 'turn-0', error: { message: 'x', codexErrorInfo: 'usageLimitExceeded' }, willRetry: false },
      },
      { method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'failed' } } },
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const frame of frames) (adapter as any).handleNotification('t', active, frame)
    expect(lastTurnEnd(events)?.limit).toBeUndefined()
  })

  it('codex: a late limit error of a stopped turn does not mark the next one before it has an id', () => {
    const events: RuntimeEvent[] = []
    const active = { ...codexActive((e) => events.push(e)), activeTurnId: null, stoppedTurnIds: new Set(['turn-0']) }
    const adapter = new CodexAdapter()
    const frames = [
      {
        method: 'error',
        params: { turnId: 'turn-0', error: { message: 'x', codexErrorInfo: 'usageLimitExceeded' }, willRetry: false },
      },
      { method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'failed' } } },
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const frame of frames) (adapter as any).handleNotification('t', active, frame)
    expect(lastTurnEnd(events)?.limit).toBeUndefined()
  })

  it('claude: an overage rejection keeps the usage limit but no reset time', () => {
    const events: RuntimeEvent[] = []
    const active = claudeActive((e) => events.push(e))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(new ClaudeAdapter() as any).handleSDKMessage('t', active, {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'rejected',
        rateLimitType: 'overage',
        overageStatus: 'rejected',
        resetsAt: 1761045600,
      },
    })
    expect(lastTurnEnd(events)?.limit).toEqual({ limitClass: 'usage_limit', resetAt: null })
  })
})
