import { describe, it, expect, vi } from 'vitest'
import { ClaudeAdapter } from '../../src/main/provider/adapters/claude-adapter'

/**
 * Regression (2026-06-10): stopSession never called query.close(), so each
 * stopped session leaked its spawned `claude` CLI subprocess.
 */

function makeActive(query: unknown) {
  return {
    session: {
      threadId: 'thread-1',
      provider: 'claude' as const,
      status: 'running' as const,
      runtimeMode: 'sandbox' as const,
      cwd: '/tmp',
      createdAt: 0,
    },
    query,
    prompt: { close: vi.fn() } as never,
    onEvent: vi.fn(),
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

function withSession(adapter: ClaudeAdapter, active: ReturnType<typeof makeActive>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(adapter as any).sessions.set('thread-1', active)
}

function sessionsMap(adapter: ClaudeAdapter): Map<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (adapter as any).sessions
}

describe('ClaudeAdapter.stopSession - subprocess teardown', () => {
  it('calls query.close() to reap the CLI subprocess', async () => {
    const close = vi.fn()
    const adapter = new ClaudeAdapter()
    const active = makeActive({ close })
    withSession(adapter, active)

    await adapter.stopSession('thread-1')

    expect(close).toHaveBeenCalledTimes(1)
  })

  it('aborts the controller and closes the prompt queue as well', async () => {
    const adapter = new ClaudeAdapter()
    const active = makeActive({ close: vi.fn() })
    withSession(adapter, active)

    await adapter.stopSession('thread-1')

    expect(active.abortController.signal.aborted).toBe(true)
    expect((active.prompt as unknown as { close: () => void }).close).toHaveBeenCalled()
  })

  it('removes the session from the registry after stopping', async () => {
    const adapter = new ClaudeAdapter()
    withSession(adapter, makeActive({ close: vi.fn() }))

    await adapter.stopSession('thread-1')

    expect(sessionsMap(adapter).has('thread-1')).toBe(false)
  })

  it('does not throw when query.close() throws - cleanup still completes', async () => {
    const close = vi.fn(() => {
      throw new Error('subprocess already gone')
    })
    const adapter = new ClaudeAdapter()
    const active = makeActive({ close })
    withSession(adapter, active)

    await expect(adapter.stopSession('thread-1')).resolves.toBeUndefined()
    expect(close).toHaveBeenCalled()
    expect(active.abortController.signal.aborted).toBe(true)
    expect(sessionsMap(adapter).has('thread-1')).toBe(false)
  })

  it('handles a session that never started a query (query === null)', async () => {
    const adapter = new ClaudeAdapter()
    withSession(adapter, makeActive(null))

    await expect(adapter.stopSession('thread-1')).resolves.toBeUndefined()
    expect(sessionsMap(adapter).has('thread-1')).toBe(false)
  })

  it('is a no-op for an unknown thread', async () => {
    const adapter = new ClaudeAdapter()
    await expect(adapter.stopSession('nope')).resolves.toBeUndefined()
  })
})
