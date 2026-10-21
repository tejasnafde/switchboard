import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DemoAdapter, demoAdapters } from '../../src/main/provider/adapters/demo-adapter'
import type { RuntimeEvent } from '@shared/provider-events'

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

/**
 * The adapter's script is a chain of timed pauses. Under fake timers each
 * step jumps to the next pause, so a turn takes no real time and the checks
 * run in the same order the script emits events.
 */
async function advanceUntil(done: () => boolean): Promise<void> {
  while (!done()) {
    if (vi.getTimerCount() === 0) throw new Error('the script stopped before the condition held')
    await vi.advanceTimersToNextTimerAsync()
  }
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  let finished = false
  void promise
    .finally(() => {
      finished = true
    })
    .catch(() => {})
  await advanceUntil(() => finished)
  return promise
}

async function runTurn(mode: 'plan' | 'sandbox', message: string, cwd: string): Promise<RuntimeEvent[]> {
  const adapter = new DemoAdapter('claude')
  const events: RuntimeEvent[] = []
  await settle(
    adapter.startSession({ threadId: 't1', provider: 'claude', cwd, runtimeMode: mode }, (e) => events.push(e)),
  )
  await adapter.sendTurn('t1', message, mode)
  await advanceUntil(() => events.some((e) => e.type === 'turn.completed'))
  return events
}

describe('DemoAdapter (tour recorder script)', () => {
  let cwd: string
  beforeEach(() => {
    vi.useFakeTimers()
    cwd = mkdtempSync(join(tmpdir(), 'sb-demo-adapter-'))
    mkdirSync(join(cwd, 'src', 'api'), { recursive: true })
    writeFileSync(join(cwd, 'src', 'api', 'auth.ts'), 'export async function exchangeCode() {}\n')
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('plan mode reads, then emits a denied Write and never touches the tree', async () => {
    const events = await runTurn('plan', 'Refactor the auth callback', cwd)
    const denied = events.filter((e) => e.type === 'tool.denied')
    expect(denied).toHaveLength(1)
    expect(denied[0]).toMatchObject({ toolName: 'Write', mode: 'plan' })
    const started = events.filter((e) => e.type === 'tool.started').map((e) => (e as { toolName: string }).toolName)
    expect(started).toEqual(['Read', 'Read'])
    expect(readFileSync(join(cwd, 'src', 'api', 'auth.ts'), 'utf8')).toContain('exchangeCode() {}')
  })

  it('an edit request rewrites src/api/auth.ts in the session cwd', async () => {
    const events = await runTurn('sandbox', 'Move the state check ahead of the exchange.', cwd)
    expect(events.some((e) => e.type === 'tool.started' && e.toolName === 'Edit')).toBe(true)
    expect(readFileSync(join(cwd, 'src', 'api', 'auth.ts'), 'utf8')).toContain('verifyState(state)')
    expect(events.some((e) => e.type === 'tool.denied')).toBe(false)
  })

  it('streams assistant text as appended deltas under one messageId', async () => {
    const events = await runTurn('sandbox', 'What do the tests cover?', cwd)
    const content = events.filter((e) => e.type === 'content') as Array<{
      messageId: string
      append?: boolean
      text: string
    }>
    expect(content.length).toBeGreaterThan(3)
    expect(new Set(content.map((c) => c.messageId)).size).toBe(1)
    expect(content[0].append).toBe(false)
    expect(content.slice(1).every((c) => c.append)).toBe(true)
    expect(content.map((c) => c.text).join('')).toMatch(/^Two focused tests/)
  })

  it('reports the scripted duration, identical on every run', async () => {
    const duration = (events: RuntimeEvent[]) => events.find((e) => e.type === 'turn.completed')
    const [first, second] = await Promise.all([
      runTurn('sandbox', 'What do the tests cover?', cwd),
      runTurn('sandbox', 'What do the tests cover?', cwd),
    ])
    expect(duration(first)).toMatchObject({ durationMs: expect.any(Number) })
    expect(duration(first)).toEqual(duration(second))
  })

  it('a run request holds the turn on an approval until it is answered', async () => {
    const adapter = new DemoAdapter('claude')
    const events: RuntimeEvent[] = []
    await settle(
      adapter.startSession({ threadId: 't1', provider: 'claude', cwd, runtimeMode: 'sandbox' }, (e) => events.push(e)),
    )
    await adapter.sendTurn('t1', 'Run the auth tests', 'sandbox')
    await advanceUntil(() => events.some((e) => e.type === 'request.opened'))
    const opened = events.find((e) => e.type === 'request.opened') as Extract<RuntimeEvent, { type: 'request.opened' }>
    expect(opened).toMatchObject({ requestType: 'command', toolName: 'Bash', detail: 'npm test' })
    expect(events.some((e) => e.type === 'turn.completed')).toBe(false)
    await adapter.respondToRequest('t1', opened.requestId, 'approve')
    await advanceUntil(() => events.some((e) => e.type === 'turn.completed'))
    expect(events.some((e) => e.type === 'request.closed' && e.decision === 'approve')).toBe(true)
    expect(events.some((e) => e.type === 'tool.started' && e.toolName === 'Bash')).toBe(true)
  })

  it('a review reply opens a pull request write card and posts nothing on approval', async () => {
    const adapter = new DemoAdapter('claude')
    const events: RuntimeEvent[] = []
    await settle(
      adapter.startSession({ threadId: 't1', provider: 'claude', cwd, runtimeMode: 'sandbox' }, (e) => events.push(e)),
    )
    await adapter.sendTurn('t1', 'Reply to the review conversations.', 'sandbox')
    await advanceUntil(() => events.some((e) => e.type === 'request.opened'))
    const card = events.find((e) => e.type === 'request.opened') as Extract<RuntimeEvent, { type: 'request.opened' }>
    expect(card.hostWrite).toMatchObject({
      action: 'reply',
      prLabel: 'ssg-bot-v2 #612',
      location: 'sync/worker.py:86',
      suggestResolve: true,
    })
    expect(card.detail).toContain('Reply on ssg-bot-v2 #612')
    await adapter.respondToRequest('t1', card.requestId, 'approve')
    await advanceUntil(() => events.some((e) => e.type === 'turn.completed'))
    expect(events).toContainEqual({
      type: 'request.closed',
      threadId: 't1',
      requestId: card.requestId,
      decision: 'approve',
    })
  })

  it('raising a pull request opens a create card with the branches and an editable draft, and opens nothing', async () => {
    const adapter = new DemoAdapter('claude')
    const events: RuntimeEvent[] = []
    await settle(
      adapter.startSession({ threadId: 't1', provider: 'claude', cwd, runtimeMode: 'sandbox' }, (e) => events.push(e)),
    )
    await adapter.sendTurn('t1', 'Raise a pull request for this.', 'sandbox')
    await advanceUntil(() => events.some((e) => e.type === 'request.opened'))
    const card = events.find((e) => e.type === 'request.opened') as Extract<RuntimeEvent, { type: 'request.opened' }>
    expect(card.toolName).toBe('mcp__switchboard__create_pull_request')
    expect(card.hostWrite).toMatchObject({
      action: 'create',
      host: 'bitbucket',
      create: { sourceBranch: 'feat/sync-jitter', targetBranch: 'main', draft: false },
    })
    expect(card.detail).toContain('Open a pull request on geoiq/ssg-bot-v2: feat/sync-jitter -> main')
    await adapter.respondToRequest('t1', card.requestId, 'deny')
    await advanceUntil(() => events.some((e) => e.type === 'turn.completed'))
    expect(events).toContainEqual({
      type: 'request.closed',
      threadId: 't1',
      requestId: card.requestId,
      decision: 'deny',
    })
  })

  it('a draft review opens one review card with every verdict offered and none chosen, and posts nothing', async () => {
    const adapter = new DemoAdapter('claude')
    const events: RuntimeEvent[] = []
    await settle(
      adapter.startSession({ threadId: 't1', provider: 'claude', cwd, runtimeMode: 'sandbox' }, (e) => events.push(e)),
    )
    await adapter.sendTurn('t1', 'Draft a review of the pull request.', 'sandbox')
    await advanceUntil(() => events.some((e) => e.type === 'request.opened'))
    const card = events.find((e) => e.type === 'request.opened') as Extract<RuntimeEvent, { type: 'request.opened' }>
    expect(card.toolName).toBe('mcp__switchboard__draft_review')
    expect(card.hostWrite).toMatchObject({ action: 'review', prLabel: 'switchboard #161' })
    expect(card.hostWrite?.review?.comments).toHaveLength(3)
    expect(card.hostWrite?.review?.verdicts).toEqual(['comment', 'approve', 'request_changes'])
    expect(card.detail).toContain('Review switchboard #161 with 3 line comments')
    await adapter.respondToRequest('t1', card.requestId, 'deny')
    await advanceUntil(() => events.some((e) => e.type === 'turn.completed'))
    expect(events).toContainEqual({
      type: 'request.closed',
      threadId: 't1',
      requestId: card.requestId,
      decision: 'deny',
    })
  })

  it('interrupting a turn blocked on an approval closes the approval without completing', async () => {
    const adapter = new DemoAdapter('claude')
    const events: RuntimeEvent[] = []
    await settle(
      adapter.startSession({ threadId: 't1', provider: 'claude', cwd, runtimeMode: 'sandbox' }, (e) => events.push(e)),
    )
    await adapter.sendTurn('t1', 'Run the auth tests', 'sandbox')
    await advanceUntil(() => events.some((e) => e.type === 'request.opened'))
    await adapter.interruptTurn('t1')
    await vi.runAllTimersAsync()
    expect(events.some((e) => e.type === 'turn.completed')).toBe(false)
    expect(events.some((e) => e.type === 'request.closed' && e.decision === 'deny')).toBe(true)
  })

  it('a steer that opens a second approval leaves the first one answerable', async () => {
    const adapter = new DemoAdapter('claude')
    const events: RuntimeEvent[] = []
    await settle(
      adapter.startSession({ threadId: 't1', provider: 'claude', cwd, runtimeMode: 'sandbox' }, (e) => events.push(e)),
    )
    const opened = (): string[] => events.flatMap((e) => (e.type === 'request.opened' ? [e.requestId] : []))
    await adapter.sendTurn('t1', 'Run the auth tests', 'sandbox')
    await advanceUntil(() => opened().length >= 1)
    await adapter.sendTurn('t1', 'Run them again', 'sandbox', undefined, 'steer')
    await advanceUntil(() => opened().length >= 2)
    await adapter.respondToRequest('t1', opened()[0], 'approve')
    await advanceUntil(() => events.some((e) => e.type === 'turn.completed'))
    // The second approval is still open, so the session must not read idle.
    const lastStatus = (): string | undefined => events.filter((e) => e.type === 'status').at(-1)?.status
    expect(lastStatus()).toBe('running')
    await adapter.respondToRequest('t1', opened()[1], 'deny')
    await advanceUntil(() => events.filter((e) => e.type === 'turn.completed').length >= 2)
    expect(lastStatus()).toBe('idle')
  })

  it('an explicit run request wins over edit keywords in the same message', async () => {
    const adapter = new DemoAdapter('claude')
    const events: RuntimeEvent[] = []
    await settle(
      adapter.startSession({ threadId: 't1', provider: 'claude', cwd, runtimeMode: 'sandbox' }, (e) => events.push(e)),
    )
    await adapter.sendTurn('t1', 'Run the tests to validate the state fix', 'sandbox')
    await advanceUntil(() => events.some((e) => e.type === 'request.opened'))
    expect(events.some((e) => e.type === 'tool.started' && e.toolName === 'Edit')).toBe(false)
    expect(readFileSync(join(cwd, 'src', 'api', 'auth.ts'), 'utf8')).toContain('exchangeCode() {}')
    await adapter.interruptTurn('t1')
  })

  it('an interrupt before the approval opens never registers it, so a queued turn still runs', async () => {
    const adapter = new DemoAdapter('claude')
    const events: RuntimeEvent[] = []
    await settle(
      adapter.startSession({ threadId: 't1', provider: 'claude', cwd, runtimeMode: 'sandbox' }, (e) => events.push(e)),
    )
    await adapter.sendTurn('t1', 'Run the auth tests', 'sandbox')
    // Still inside the opening pause, before the approval exists.
    await adapter.interruptTurn('t1')
    await adapter.sendTurn('t1', 'What do the tests cover?', 'sandbox', undefined, 'queue')
    await advanceUntil(() => events.some((e) => e.type === 'turn.completed'))
    expect(events.some((e) => e.type === 'request.opened')).toBe(false)
    expect(events.filter((e) => e.type === 'turn.completed')).toHaveLength(1)
  })

  it('a tool interrupted mid-wait does not resume once the next turn starts', async () => {
    const adapter = new DemoAdapter('claude')
    const events: RuntimeEvent[] = []
    await settle(
      adapter.startSession({ threadId: 't1', provider: 'claude', cwd, runtimeMode: 'sandbox' }, (e) => events.push(e)),
    )
    await adapter.sendTurn('t1', 'Move the state check ahead of the exchange.', 'sandbox')
    await advanceUntil(() => events.some((e) => e.type === 'tool.started' && e.toolName === 'Edit'))
    await adapter.interruptTurn('t1')
    await adapter.sendTurn('t1', 'What do the tests cover?', 'sandbox')
    await advanceUntil(() => events.some((e) => e.type === 'turn.completed'))
    await vi.runAllTimersAsync()

    expect(events.some((e) => e.type === 'tool.completed')).toBe(false)
    expect(readFileSync(join(cwd, 'src', 'api', 'auth.ts'), 'utf8')).toContain('exchangeCode() {}')
    const text = (events.filter((e) => e.type === 'content') as Array<{ text: string }>).map((c) => c.text).join('')
    expect(text).not.toMatch(/Done\. The callback/)
  })

  it('exposes one scripted adapter per provider kind', () => {
    const map = demoAdapters()
    expect([...map.keys()].sort()).toEqual(['claude', 'codex', 'opencode'])
    expect(map.get('codex')?.provider).toBe('codex')
  })
})
