import { describe, it, expect, vi } from 'vitest'
import { ClaudeAdapter } from '../../src/main/provider/adapters/claude-adapter'
import type { RuntimeEvent } from '../../src/shared/provider-events'

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
    query: null,
    prompt: { push: vi.fn() } as never,
    onEvent,
    abortController: new AbortController(),
    pendingApprovals: new Map(),
    pendingQuestions: new Map(),
    currentMessageId: null,
    draining: false,
    turnStartedAt: null,
    skills: [],
    instanceEnv: {},
    instanceOauthDir: null,
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
  it('emits error then status:error on rejected with rateLimitType and resetsAt', () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600
    const events = dispatch({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt },
    })
    expect(events).toHaveLength(2)
    expect(events[0].type).toBe('error')
    expect((events[0] as { type: 'error'; message: string }).message).toContain('seven-day')
    expect(events[1]).toMatchObject({ type: 'status', status: 'error' })
  })

  it('emits error then status:error on rejected with no optional fields', () => {
    const events = dispatch({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected' },
    })
    expect(events).toHaveLength(2)
    expect(events[0].type).toBe('error')
    expect(events[1]).toMatchObject({ type: 'status', status: 'error' })
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
