import { describe, it, expect, vi } from 'vitest'
import { ClaudeAdapter } from '../../src/main/provider/adapters/claude-adapter'
import type { RuntimeEvent } from '../../src/shared/provider-events'
import { TurnWatchdog, StderrTail } from '../../src/main/provider/turn-watchdog'

function makeActive(onEvent = vi.fn()) {
  return {
    session: {
      threadId: 'thread-1',
      provider: 'claude' as const,
      status: 'running' as const,
      runtimeMode: 'sandbox' as const,
      cwd: '/tmp',
      createdAt: 0,
    },
    query: null as unknown,
    prompt: { push: vi.fn(), close: vi.fn() } as never,
    onEvent,
    abortController: new AbortController(),
    pendingApprovals: new Map(),
    pendingQuestions: new Map(),
    currentMessageId: null,
    // Present on the real ActiveSession; the rejection path clears both when it
    // ends the stuck turn, so the fake has to carry them too.
    currentReasoningMessageId: null,
    partialMessageText: new Map<string, string>(),
    draining: false,
    turnStartedAt: null,
    skills: [],
    instanceEnv: {},
    instanceOauthDir: null,
    lastKnownModel: null as string | null,
    watchdog: new TurnWatchdog(180_000, () => {}),
    stderrTail: new StderrTail(2_000),
  }
}

function dispatch(msg: object) {
  const adapter = new ClaudeAdapter()
  const active = makeActive()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(adapter as any).handleSDKMessage('thread-1', active, msg)
  return active.onEvent.mock.calls.map((c) => c[0] as RuntimeEvent)
}

describe('rate_limit_event', () => {
  // A rejection produces no `result` message, so the handler ends the turn
  // itself: error -> turn.completed (the end indicator) -> status:error.
  it('emits error, turn.completed, then status:error on rejected with rateLimitType and resetsAt', () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600
    const events = dispatch({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt },
    })
    // Asserting the whole sequence, not just lengths: order is the point.
    expect(events.map((e) => e.type)).toEqual(['error', 'turn.completed', 'status'])
    expect((events[0] as { type: 'error'; message: string }).message).toContain('seven-day')
    expect(events[2]).toMatchObject({ type: 'status', status: 'error' })
  })

  it('emits error, turn.completed, then status:error on rejected with no optional fields', () => {
    const events = dispatch({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected' },
    })
    expect(events.map((e) => e.type)).toEqual(['error', 'turn.completed', 'status'])
    expect(events[2]).toMatchObject({ type: 'status', status: 'error' })
  })

  it('emits nothing on allowed', () => {
    const events = dispatch({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed' },
    })
    expect(events).toHaveLength(0)
  })

  it('emits nothing on allowed_warning', () => {
    const events = dispatch({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed_warning' },
    })
    expect(events).toHaveLength(0)
  })

  it('emits nothing when rate_limit_info is missing', () => {
    const events = dispatch({ type: 'rate_limit_event' })
    expect(events).toHaveLength(0)
  })
})

/**
 * Live capture 2026-08-05: Fable was rejected on spend, the user picked Opus and
 * resent, and the retry still ran on Fable - the log shows `context: ...
 * model=claude-fable-5` after the resend. The adapter never implemented
 * `setModel`, so `provider-registry`'s `if (adapter.setModel)` was always false
 * and only a profile switch (stopSession + startSession, which re-reads the
 * model) could change it.
 */
describe('setModel', () => {
  function adapterWithSession(query: unknown) {
    const adapter = new ClaudeAdapter()
    const active = makeActive()
    active.query = query as never
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(adapter as any).sessions.set('thread-1', active)
    return { adapter, active }
  }

  it('exists, so the registry actually dispatches to it', () => {
    expect(typeof new ClaudeAdapter().setModel).toBe('function')
  })

  it('records the model so the next query starts with it', async () => {
    const { adapter, active } = adapterWithSession(null)
    await adapter.setModel('thread-1', 'opus')
    expect(active.session.model).toBe('opus')
  })

  it('applies to a live query', async () => {
    const setModel = vi.fn().mockResolvedValue(undefined)
    const { adapter } = adapterWithSession({ setModel })
    await adapter.setModel('thread-1', 'opus')
    expect(setModel).toHaveBeenCalledWith('opus')
  })

  it('retargets rate-limit attribution, so a rejection names the new model', async () => {
    const { adapter, active } = adapterWithSession(null)
    active.lastKnownModel = 'claude-fable-5'
    await adapter.setModel('thread-1', 'claude-opus-5')
    expect(active.lastKnownModel).toBe('claude-opus-5')
  })

  it('still records the model when the live call rejects', async () => {
    const setModel = vi.fn().mockRejectedValue(new Error('query closed'))
    const { adapter, active } = adapterWithSession({ setModel })
    await expect(adapter.setModel('thread-1', 'opus')).resolves.toBeUndefined()
    expect(active.session.model).toBe('opus')
  })

  it('is a no-op for an unknown thread', async () => {
    await expect(new ClaudeAdapter().setModel('nope', 'opus')).resolves.toBeUndefined()
  })
})
