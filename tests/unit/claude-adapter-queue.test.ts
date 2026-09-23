import { describe, it, expect, vi } from 'vitest'
import { ClaudeAdapter } from '../../src/main/provider/adapters/claude-adapter'
import { TurnWatchdog, StderrTail } from '../../src/main/provider/turn-watchdog'

function makeActive(query: unknown) {
  return {
    session: {
      threadId: 'thread-1',
      provider: 'claude' as const,
      status: 'idle' as string,
      runtimeMode: 'sandbox' as string,
      cwd: '/tmp',
      createdAt: 0,
    },
    query,
    prompt: { push: vi.fn(), close: vi.fn() },
    onEvent: vi.fn(),
    abortController: new AbortController(),
    pendingApprovals: new Map(),
    pendingQuestions: new Map(),
    currentMessageId: null,
    // Already draining, so sendTurn only pushes into the prompt queue.
    draining: true,
    turnStartedAt: null as number | null,
    queuedModes: [] as Array<string | undefined>,
    skills: [],
    instanceEnv: {},
    instanceOauthDir: null,
    watchdog: new TurnWatchdog(180_000, () => {}),
    stderrTail: new StderrTail(2_000),
  }
}

function withSession(adapter: ClaudeAdapter, active: ReturnType<typeof makeActive>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(adapter as any).sessions.set('thread-1', active)
}

describe('ClaudeAdapter queued turns', () => {
  it('queues a send that arrives while the running send applies its mode', async () => {
    let releaseMode!: () => void
    const setPermissionMode = vi.fn(() => new Promise<void>((resolve) => { releaseMode = resolve }))
    const adapter = new ClaudeAdapter()
    const active = makeActive({ setPermissionMode })
    withSession(adapter, active)

    const first = adapter.sendTurn('thread-1', 'first', 'full-access')
    await adapter.sendTurn('thread-1', 'queued', 'plan', undefined, 'queue')
    releaseMode()
    await first

    const pushed = active.prompt.push.mock.calls.map(([m]) => m)
    const queued = pushed.find((m) => m.message.content === 'queued')
    expect(queued?.priority).toBe('later')
    expect(active.queuedModes).toEqual(['plan'])
    // The queued message's mode waits for its own turn.
    expect(active.session.runtimeMode).toBe('full-access')
    active.watchdog.turnEnded()
  })

  it('ends every queued turn when the query stops before they run', () => {
    const adapter = new ClaudeAdapter()
    const active = makeActive(null)
    active.queuedModes = ['plan', undefined]
    withSession(adapter, active)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(adapter as any).dropQueuedTurns('thread-1', active)

    const events = active.onEvent.mock.calls.map(([e]) => e)
    expect(events.filter((e) => e.type === 'turn.completed')).toHaveLength(2)
    expect(events.some((e) => e.type === 'error')).toBe(true)
    expect(active.queuedModes).toEqual([])
  })
})
