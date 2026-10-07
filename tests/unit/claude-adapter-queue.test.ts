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
    prompt: { push: vi.fn(), close: vi.fn(), remove: vi.fn(() => false) },
    onEvent: vi.fn(),
    abortController: new AbortController(),
    pendingApprovals: new Map(),
    pendingQuestions: new Map(),
    currentMessageId: null,
    // Already draining, so sendTurn only pushes into the prompt queue.
    draining: true,
    turnStartedAt: null as number | null,
    queuedTurns: [] as Array<{ id?: string; uuid: string; message: string; runtimeMode?: string; sdkMessage: unknown }>,
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
    expect(typeof queued?.uuid).toBe('string')
    expect(active.queuedTurns.map((t) => t.runtimeMode)).toEqual(['plan'])
    // The queued message's mode waits for its own turn.
    expect(active.session.runtimeMode).toBe('full-access')
    active.watchdog.turnEnded()
  })

  it('ends every queued turn when the query stops before they run', () => {
    const adapter = new ClaudeAdapter()
    const active = makeActive(null)
    active.queuedTurns = [
      { id: 'remote_a', uuid: 'u1', message: 'a', runtimeMode: 'plan', sdkMessage: {} },
      { uuid: 'u2', message: 'b', sdkMessage: {} },
    ]
    withSession(adapter, active)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(adapter as any).dropQueuedTurns('thread-1', active)

    const events = active.onEvent.mock.calls.map(([e]) => e)
    expect(events.filter((e) => e.type === 'turn.completed')).toHaveLength(2)
    expect(events.some((e) => e.type === 'error')).toBe(true)
    // Only a message the registry named is announced as leaving the queue.
    expect(events.filter((e) => e.type === 'turn.dequeued')).toEqual([
      { type: 'turn.dequeued', threadId: 'thread-1', messageId: 'remote_a', reason: 'dropped' },
    ])
    expect(active.queuedTurns).toEqual([])
  })

  function running(query: unknown) {
    const adapter = new ClaudeAdapter()
    const active = makeActive(query)
    active.turnStartedAt = Date.now()
    withSession(adapter, active)
    return { adapter, active }
  }

  it('announces a held message and cancels it in the CLI queue by its uuid', async () => {
    const cancelAsyncMessage = vi.fn(async () => true)
    const { adapter, active } = running({ cancelAsyncMessage })
    await adapter.sendTurn('thread-1', 'take me back', undefined, undefined, 'queue', 'remote_q1')
    expect(active.onEvent).toHaveBeenCalledWith({ type: 'turn.queued', threadId: 'thread-1', messageId: 'remote_q1' })
    const uuid = active.queuedTurns[0].uuid

    await expect(adapter.cancelQueuedTurn('thread-1', 'remote_q1')).resolves.toBe(true)
    expect(cancelAsyncMessage).toHaveBeenCalledWith(uuid)
    expect(active.queuedTurns).toEqual([])
    expect(active.onEvent).toHaveBeenCalledWith({ type: 'turn.dequeued', threadId: 'thread-1', messageId: 'remote_q1', reason: 'cancelled' })
    active.watchdog.turnEnded()
  })

  it('takes a message the SDK has not read yet out of the local prompt queue', async () => {
    const cancelAsyncMessage = vi.fn(async () => true)
    const { adapter, active } = running({ cancelAsyncMessage })
    active.prompt.remove.mockReturnValue(true)
    await adapter.sendTurn('thread-1', 'unread', undefined, undefined, 'queue', 'remote_q1')
    await expect(adapter.cancelQueuedTurn('thread-1', 'remote_q1')).resolves.toBe(true)
    expect(cancelAsyncMessage).not.toHaveBeenCalled()
    active.watchdog.turnEnded()
  })

  it('reports false, and keeps the entry, when the message already left the CLI queue', async () => {
    const { adapter, active } = running({ cancelAsyncMessage: vi.fn(async () => false) })
    await adapter.sendTurn('thread-1', 'too late', undefined, undefined, 'queue', 'remote_q1')
    await expect(adapter.cancelQueuedTurn('thread-1', 'remote_q1')).resolves.toBe(false)
    expect(active.queuedTurns).toHaveLength(1)
    expect(active.onEvent.mock.calls.some(([e]) => e.type === 'turn.dequeued')).toBe(false)
    active.watchdog.turnEnded()
  })

  it('promotes by withdrawing the later message and sending the same text as a steer', async () => {
    const cancelAsyncMessage = vi.fn(async () => true)
    const { adapter, active } = running({ cancelAsyncMessage, setPermissionMode: vi.fn(async () => {}) })
    await adapter.sendTurn('thread-1', 'steer me in', undefined, undefined, 'queue', 'remote_q1')
    await expect(adapter.promoteQueuedTurn('thread-1', 'remote_q1')).resolves.toBe(true)

    const pushed = active.prompt.push.mock.calls.map(([m]) => m)
    expect(pushed).toHaveLength(2)
    expect(pushed[1].message.content).toBe('steer me in')
    expect(pushed[1].priority).toBeUndefined()
    expect(active.queuedTurns).toEqual([])
    expect(active.onEvent).toHaveBeenCalledWith({ type: 'turn.dequeued', threadId: 'thread-1', messageId: 'remote_q1', reason: 'promoted' })
    active.watchdog.turnEnded()
  })

  it('promotes without changing the running turn\'s mode', async () => {
    const setPermissionMode = vi.fn(async () => {})
    const { adapter, active } = running({ cancelAsyncMessage: vi.fn(async () => true), setPermissionMode })
    await adapter.sendTurn('thread-1', 'written in full access', 'full-access', undefined, 'queue', 'remote_q1')
    await adapter.promoteQueuedTurn('thread-1', 'remote_q1')
    expect(setPermissionMode).not.toHaveBeenCalled()
    expect(active.session.runtimeMode).toBe('sandbox')
    active.watchdog.turnEnded()
  })

  it('reports a promote whose steer fails as dropped, and ends its turn', async () => {
    const { adapter, active } = running({ cancelAsyncMessage: vi.fn(async () => true) })
    await adapter.sendTurn('thread-1', 'lost', undefined, undefined, 'queue', 'remote_q1')
    active.prompt.push.mockImplementationOnce(() => { throw new Error('queue closed') })
    await expect(adapter.promoteQueuedTurn('thread-1', 'remote_q1')).rejects.toThrow('queue closed')
    const events = active.onEvent.mock.calls.map(([e]) => e)
    expect(events).toContainEqual({ type: 'turn.dequeued', threadId: 'thread-1', messageId: 'remote_q1', reason: 'dropped' })
    expect(events.some((e) => e.type === 'turn.completed')).toBe(true)
    expect(events.some((e) => e.type === 'turn.dequeued' && e.reason === 'promoted')).toBe(false)
    active.watchdog.turnEnded()
  })

  it('does not count a message being cancelled as the one that starts next', async () => {
    let finishCancel!: (v: boolean) => void
    const cancelAsyncMessage = vi.fn(() => new Promise<boolean>((resolve) => { finishCancel = resolve }))
    const { adapter, active } = running({ cancelAsyncMessage, setPermissionMode: vi.fn(async () => {}) })
    await adapter.sendTurn('thread-1', 'a', undefined, undefined, 'queue', 'remote_a')
    await adapter.sendTurn('thread-1', 'b', undefined, undefined, 'queue', 'remote_b')
    const cancel = adapter.cancelQueuedTurn('thread-1', 'remote_a')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(adapter as any).startQueuedTurn(active)
    // Nothing starts until the cancel says which message the CLI runs.
    expect(active.onEvent.mock.calls.some(([e]) => e.type === 'turn.dequeued')).toBe(false)
    finishCancel(true)
    await expect(cancel).resolves.toBe(true)
    const dequeued = active.onEvent.mock.calls.map(([e]) => e).filter((e) => e.type === 'turn.dequeued')
    expect(dequeued).toEqual([
      { type: 'turn.dequeued', threadId: 'thread-1', messageId: 'remote_b', reason: 'started' },
      { type: 'turn.dequeued', threadId: 'thread-1', messageId: 'remote_a', reason: 'cancelled' },
    ])
    active.watchdog.turnEnded()
  })

  it('starts the head, with its own mode, when a cancel racing the turn end fails', async () => {
    let finishCancel!: (v: boolean) => void
    const cancelAsyncMessage = vi.fn(() => new Promise<boolean>((resolve) => { finishCancel = resolve }))
    const setPermissionMode = vi.fn(async () => {})
    const { adapter, active } = running({ cancelAsyncMessage, setPermissionMode })
    await adapter.sendTurn('thread-1', 'a', 'plan', undefined, 'queue', 'remote_a')
    await adapter.sendTurn('thread-1', 'b', 'full-access', undefined, 'queue', 'remote_b')
    const cancel = adapter.cancelQueuedTurn('thread-1', 'remote_a')
    active.turnStartedAt = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(adapter as any).startQueuedTurn(active)
    finishCancel(false)
    await expect(cancel).resolves.toBe(false)
    const dequeued = active.onEvent.mock.calls.map(([e]) => e).filter((e) => e.type === 'turn.dequeued')
    expect(dequeued).toEqual([
      { type: 'turn.dequeued', threadId: 'thread-1', messageId: 'remote_a', reason: 'started' },
    ])
    expect(active.session.runtimeMode).toBe('plan')
    expect(setPermissionMode).not.toHaveBeenCalledWith('bypassPermissions')
    expect(active.turnStartedAt).not.toBeNull()
    expect(active.queuedTurns.map((t) => t.id)).toEqual(['remote_b'])
    active.watchdog.turnEnded()
  })

  it('starts the head with its own mode when a cancel racing the turn end rejects', async () => {
    let failCancel!: (err: Error) => void
    const cancelAsyncMessage = vi.fn(() => new Promise<boolean>((_resolve, reject) => { failCancel = reject }))
    const { adapter, active } = running({ cancelAsyncMessage, setPermissionMode: vi.fn(async () => {}) })
    await adapter.sendTurn('thread-1', 'a', 'plan', undefined, 'queue', 'remote_a')
    await adapter.sendTurn('thread-1', 'b', 'full-access', undefined, 'queue', 'remote_b')
    const cancel = adapter.cancelQueuedTurn('thread-1', 'remote_a')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(adapter as any).startQueuedTurn(active)
    failCancel(new Error('control channel closed'))
    await expect(cancel).resolves.toBe(false)
    const dequeued = active.onEvent.mock.calls.map(([e]) => e).filter((e) => e.type === 'turn.dequeued')
    expect(dequeued).toEqual([{ type: 'turn.dequeued', threadId: 'thread-1', messageId: 'remote_a', reason: 'started' }])
    expect(active.session.runtimeMode).toBe('plan')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((active as any).startAfterWithdraw).toBe(false)
    active.watchdog.turnEnded()
  })

  it('forgets a deferred start when the queue is dropped, so a later cancel starts nothing', async () => {
    let finishCancel!: (v: boolean) => void
    const cancelAsyncMessage = vi.fn(() => new Promise<boolean>((resolve) => { finishCancel = resolve }))
    const { adapter, active } = running({ cancelAsyncMessage, setPermissionMode: vi.fn(async () => {}) })
    await adapter.sendTurn('thread-1', 'a', undefined, undefined, 'queue', 'remote_a')
    const cancel = adapter.cancelQueuedTurn('thread-1', 'remote_a')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(adapter as any).startQueuedTurn(active)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(adapter as any).dropQueuedTurns('thread-1', active)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((active as any).startAfterWithdraw).toBe(false)
    finishCancel(true)
    await cancel
    const reasons = active.onEvent.mock.calls.map(([e]) => e).filter((e) => e.type === 'turn.dequeued').map((e) => e.reason)
    expect(reasons).not.toContain('started')
    active.watchdog.turnEnded()
  })

  it('clears a deferred start on stopSession', async () => {
    const { adapter, active } = running({ close: vi.fn(), cancelAsyncMessage: vi.fn(() => new Promise<boolean>(() => {})) })
    await adapter.sendTurn('thread-1', 'a', undefined, undefined, 'queue', 'remote_a')
    void adapter.cancelQueuedTurn('thread-1', 'remote_a')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(adapter as any).startQueuedTurn(active)
    await adapter.stopSession('thread-1')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((active as any).startAfterWithdraw).toBe(false)
  })

  it('says a queued message started when the turn ahead of it ends', async () => {
    const { adapter, active } = running({ setPermissionMode: vi.fn(async () => {}) })
    await adapter.sendTurn('thread-1', 'next', 'plan', undefined, 'queue', 'remote_q1')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(adapter as any).startQueuedTurn(active)
    expect(active.onEvent).toHaveBeenCalledWith({ type: 'turn.dequeued', threadId: 'thread-1', messageId: 'remote_q1', reason: 'started' })
    expect(active.queuedTurns).toEqual([])
    active.watchdog.turnEnded()
  })
})

describe('ClaudeAdapter holds the queue after a usage limit or a failed turn', () => {
  const rejected = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1 } }

  async function queuedBehindRunningTurn(cancelAsyncMessage: (uuid: string) => Promise<boolean>) {
    const adapter = new ClaudeAdapter()
    const active = { ...makeActive({ cancelAsyncMessage, setPermissionMode: vi.fn(async () => {}), getContextUsage: vi.fn(async () => ({ totalTokens: 1, maxTokens: 2, percentage: 50 })) }), currentReasoningMessageId: null, partialMessageText: new Map(), lastKnownModel: null }
    active.turnStartedAt = Date.now()
    withSession(adapter, active)
    await adapter.sendTurn('thread-1', 'q1', undefined, undefined, 'queue', 'remote_q1')
    await adapter.sendTurn('thread-1', 'q2', undefined, undefined, 'queue', 'remote_q2')
    return { adapter, active, events: () => active.onEvent.mock.calls.map(([e]) => e) }
  }

  it('takes the queued messages back out of the CLI, holds them, and pushes them again on resume', async () => {
    const cancelAsyncMessage = vi.fn(async () => true)
    const { adapter, active, events } = await queuedBehindRunningTurn(cancelAsyncMessage)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(adapter as any).handleSDKMessage('thread-1', active, rejected)
    await vi.waitFor(() => expect(cancelAsyncMessage).toHaveBeenCalledTimes(2))

    expect(events()).toContainEqual({ type: 'turn.queue-held', threadId: 'thread-1', held: true, reason: 'The usage limit was reached.' })
    // Nothing started into the limit.
    expect(events().some((e) => e.type === 'turn.dequeued')).toBe(false)
    expect(active.queuedTurns.map((t) => (t as { held?: boolean }).held)).toEqual([true, true])

    active.prompt.push.mockClear()
    await expect(adapter.resumeQueuedTurns('thread-1')).resolves.toBe(true)
    expect(active.prompt.push.mock.calls.map(([m]) => m.message.content)).toEqual(['q1', 'q2'])
    // Idle, so the CLI runs the first one now.
    expect(events()).toContainEqual({ type: 'turn.dequeued', threadId: 'thread-1', messageId: 'remote_q1', reason: 'started' })
    expect(events()).toContainEqual({ type: 'turn.queue-held', threadId: 'thread-1', held: false })
    active.watchdog.turnEnded()
  })

  it('a held message is ours alone: cancel needs no CLI round trip', async () => {
    const cancelAsyncMessage = vi.fn(async () => true)
    const { adapter, active } = await queuedBehindRunningTurn(cancelAsyncMessage)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(adapter as any).handleSDKMessage('thread-1', active, { type: 'result', is_error: true, subtype: 'error_during_execution' })
    await vi.waitFor(() => expect(cancelAsyncMessage).toHaveBeenCalledTimes(2))
    await expect(adapter.cancelQueuedTurn('thread-1', 'remote_q2')).resolves.toBe(true)
    expect(cancelAsyncMessage).toHaveBeenCalledTimes(2)
    expect(active.queuedTurns.map((t) => t.id)).toEqual(['remote_q1'])
    active.watchdog.turnEnded()
  })

  it('a message queued behind a held queue waits there instead of reaching the CLI', async () => {
    const cancelAsyncMessage = vi.fn(async () => true)
    const { adapter, active } = await queuedBehindRunningTurn(cancelAsyncMessage)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(adapter as any).handleSDKMessage('thread-1', active, rejected)
    await vi.waitFor(() => expect(cancelAsyncMessage).toHaveBeenCalledTimes(2))
    // The user starts a new turn and queues another message behind it.
    active.turnStartedAt = Date.now()
    active.prompt.push.mockClear()
    await adapter.sendTurn('thread-1', 'q3', undefined, undefined, 'queue', 'remote_q3')
    expect(active.prompt.push).not.toHaveBeenCalled()
    expect(active.queuedTurns.map((t) => [t.id, (t as { held?: boolean }).held])).toEqual([
      ['remote_q1', true], ['remote_q2', true], ['remote_q3', true],
    ])
    await expect(adapter.resumeQueuedTurns('thread-1')).resolves.toBe(true)
    expect(active.prompt.push.mock.calls.map(([m]) => m.message.content)).toEqual(['q1', 'q2', 'q3'])
    active.watchdog.turnEnded()
  })

  it('a message the CLI already took starts as before; the rest are held', async () => {
    const cancelAsyncMessage = vi.fn(async (uuid: string) => uuid !== firstUuid)
    let firstUuid = ''
    const { adapter, active, events } = await queuedBehindRunningTurn((uuid) => cancelAsyncMessage(uuid))
    firstUuid = active.queuedTurns[0].uuid
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(adapter as any).handleSDKMessage('thread-1', active, rejected)
    await vi.waitFor(() => expect(cancelAsyncMessage).toHaveBeenCalledTimes(2))
    expect(events()).toContainEqual({ type: 'turn.dequeued', threadId: 'thread-1', messageId: 'remote_q1', reason: 'started' })
    expect(active.queuedTurns.map((t) => t.id)).toEqual(['remote_q2'])
    active.watchdog.turnEnded()
  })
})
