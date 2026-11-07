/**
 * Child chats and usage limits against the real registry, LimitResumer and
 * SQLite: a limited child tells its parent, resumes at the reset with a
 * `resumed` wake, and `move_child` moves it to another account of its agent.
 */
import { createMigratedDb } from './helpers/test-db'
import './helpers/registry-session-mocks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const accounts = vi.hoisted(() => ({
  rows: [
    { id: 'claude-a', agentType: 'claude-code', displayName: 'Claude A', enabled: true },
    { id: 'claude-b', agentType: 'claude-code', displayName: 'Claude B', enabled: true },
    { id: 'codex-a', agentType: 'codex', displayName: 'Codex A', enabled: true },
  ],
}))
vi.mock('../../src/main/db/provider-instances', () => {
  const full = (id: string) => {
    const row = accounts.rows.find((r) => r.id === id)
    return row ? { ...row, env: {}, oauthDir: null } : null
  }
  return {
    resolveProviderInstance: (agentType: string, id?: string) => full(id ?? 'claude-a') ?? full('claude-a'),
    getProviderInstanceFull: full,
    listProviderInstances: () => accounts.rows,
    listOauthDirsForAgent: () => [],
  }
})

vi.mock('../../src/main/provider/remote-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/remote-gate')>()
  return { ...actual, remoteProviderLoginPrompt: () => null }
})

const usage = vi.hoisted(() => ({
  closed: new Set<string>(),
  /** The session window each account reports, in percent, for the auto-move. */
  percent: new Map<string, number>(),
  duringFetch: null as null | (() => void),
}))
vi.mock('../../src/main/provider/usage', () => ({
  fetchInstanceUsage: async (instanceId: string) => {
    // A reading takes time: a test can start a turn while it is out.
    usage.duringFetch?.()
    return {
      instanceId,
      agentType: 'claude-code',
      status: 'ok',
      plan: null,
      account: null,
      windows:
        usage.closed.has(instanceId) || usage.percent.has(instanceId)
          ? [
              {
                id: 's',
                label: '5-hour session',
                kind: 'session',
                usedPercent: usage.closed.has(instanceId) ? 100 : usage.percent.get(instanceId),
                resetsAtMs: Date.now() + 60 * 60_000,
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
  createConversation,
  getConversationProviderInstanceId,
  getHubChild,
  getLimitResume,
  insertHubChild,
  listPendingHubWakes,
  setSetting,
  updateHubChild,
} from '../../src/main/db/database'
import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import { hubResumeTurn } from '../../src/shared/hub'
import { limitResumeTurn } from '../../src/shared/limit-resume'
import { stripSenderLine } from '../../src/shared/sender-line'
import type { BackendHost } from '../../src/main/backend/host'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent, RuntimeMode } from '../../src/shared/provider-events'
import type { SwitchboardMcpServer } from '../../src/main/mcp/switchboard-mcp-server'
import type { McpTool } from '../../src/main/mcp/mcp-session'

const TMP = process.cwd()
const MIN = 60_000

class FakeHost implements BackendHost {
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  saved: Array<{ threadId: string; content: string }> = []
  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn)
  }
  on(): void {}
  emit(channel: string, event: unknown): void {
    const e = event as RuntimeEvent
    if (channel === ProviderChannels.EVENT && e.type === 'approval.result')
      this.saved.push({ threadId: e.threadId, content: e.content })
  }
  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    const fn = this.handlers.get(channel)
    if (!fn) throw new Error(`no handler registered for ${channel}`)
    return (await fn(...args)) as T
  }
}

class Adapter implements ProviderAdapter {
  readonly provider = 'claude' as const
  emit = new Map<string, (e: RuntimeEvent) => void>()
  starts: SessionStartOpts[] = []
  sent: Array<{ threadId: string; text: string }> = []
  /** The threads whose held queue was released, in order. */
  resumedQueues: string[] = []
  mode: RuntimeMode = 'full-access'
  async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    this.starts.push(opts)
    this.emit.set(opts.threadId, onEvent)
    return {
      threadId: opts.threadId,
      provider: 'claude',
      status: 'idle',
      runtimeMode: 'sandbox',
      cwd: opts.cwd,
      createdAt: 0,
    }
  }
  async sendTurn(
    threadId: string,
    text: string,
    _mode?: RuntimeMode,
    _images?: unknown,
    delivery?: 'queue' | 'steer',
    queuedId?: string,
  ): Promise<void> {
    this.sent.push({ threadId, text: stripSenderLine(text) })
    if (delivery === 'queue' && queuedId) {
      this.emit.get(threadId)?.({ type: 'turn.queued', threadId, messageId: queuedId })
      return
    }
    this.emit.get(threadId)?.({ type: 'status', threadId, status: 'running' })
  }
  async resumeQueuedTurns(threadId: string): Promise<boolean> {
    this.resumedQueues.push(threadId)
    return false
  }
  async respondToRequest(): Promise<void> {}
  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async setRuntimeMode(): Promise<void> {}
  runtimeModeOf(): RuntimeMode {
    return this.mode
  }
  async isAvailable(): Promise<boolean> {
    return true
  }
}

function fakeMcp() {
  const opened = new Map<string, McpTool[]>()
  const server = {
    async open(threadId: string, tools: () => McpTool[]) {
      opened.set(threadId, tools())
      return { command: 'node', args: [], env: {} }
    },
    close() {},
    agentPid: () => null,
  }
  return { opened, server: server as unknown as SwitchboardMcpServer }
}

let host: FakeHost
let adapter: Adapter
let registry: ProviderRegistry
let mcp: ReturnType<typeof fakeMcp>

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  createMigratedDb()
  setSetting('labs.limit_auto_resume', 'true')
  setSetting('labs.hub_children', 'true')
  addProject(TMP, 'tmp')
  createConversation('parent1', TMP, 'claude-code')
  for (const id of ['child1', 'child2']) {
    createConversation(id, TMP, 'claude-code')
    insertHubChild({
      childId: id,
      parentId: 'parent1',
      batchId: 'b1',
      ordinal: id === 'child1' ? 0 : 1,
      title: id === 'child1' ? 'Child 1' : 'Child 2',
      brief: 'Do it',
      location: 'project',
      grantedMode: 'full-access',
      depsMode: 'none',
      providerInstanceId: 'claude-a',
    })
    updateHubChild(id, { phase: 'open' })
  }
  usage.closed.clear()
  usage.percent.clear()
  usage.duringFetch = null
  host = new FakeHost()
  adapter = new Adapter()
  mcp = fakeMcp()
  registry = new ProviderRegistry(
    host,
    new Map([['claude', adapter]]),
    undefined,
    undefined,
    mcp.server,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  )
  registry.registerIpcHandlers()
  for (const threadId of ['parent1', 'child1', 'child2'])
    await host.invoke(ProviderChannels.START_SESSION, {
      threadId,
      provider: 'claude',
      cwd: TMP,
      instanceId: 'claude-a',
    })
})

afterEach(async () => {
  await registry?.stopAll()
  vi.useRealTimers()
})

const event = (e: RuntimeEvent) => adapter.emit.get(e.threadId)!(e)
/** The child got its brief, or a message from its parent: Switchboard may write one wake of its own. */
const task = (childId: string) => registry['hubNotes'].task(childId)
/**
 * The child's turn runs, then ends on a usage limit. The reset is 2 minutes
 * out by default; a test that must not see the resume fire passes a longer
 * one, so no timer the assertions run through can reach it.
 */
function limit(childId = 'child1', resetInMs = 2 * MIN) {
  event({ type: 'status', threadId: childId, status: 'running', newTurn: true })
  event({
    type: 'turn.completed',
    threadId: childId,
    limit: { limitClass: 'usage_limit', resetAt: Date.now() + resetInMs },
  })
  event({ type: 'status', threadId: childId, status: 'idle' })
}
const wakes = () =>
  listPendingHubWakes('parent1').map((w) => ({ childId: w.childId, kind: w.kind, summary: w.summary }))
const move = (childId: string, providerInstanceId: string) =>
  mcp.opened
    .get('parent1')!
    .find((t) => t.name === 'move_child')!
    .call({ childId, providerInstanceId })
const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? ''

describe('a limited child', () => {
  it('tells its parent, resumes at the reset and tells it again', async () => {
    limit()
    await vi.waitFor(() => expect(wakes()).toHaveLength(1))
    expect(wakes()[0]).toMatchObject({ childId: 'child1', kind: 'limited' })
    expect(wakes()[0]!.summary).toMatch(/^Usage limit\. Resumes \d\d:\d\d\.$/)

    await vi.advanceTimersByTimeAsync(3 * MIN)
    expect(adapter.sent.filter((s) => s.text === limitResumeTurn()).map((s) => s.threadId)).toEqual(['child1'])
    await vi.waitFor(() => expect(wakes().map((w) => w.kind)).toEqual(['limited', 'resumed']))
  })

  it('waits for a run slot at the reset, and resumes when the running child stops', async () => {
    setSetting('hub.runningPerInstance', '1')
    event({ type: 'status', threadId: 'child2', status: 'running', newTurn: true })
    limit('child1')
    await vi.advanceTimersByTimeAsync(3 * MIN)
    expect(adapter.sent.some((s) => s.text === limitResumeTurn())).toBe(false)
    expect(registry.hubView('parent1').children.find((c) => c.chat.id === 'child1')).toMatchObject({
      state: 'starting',
      waitingForSlot: true,
    })
    event({ type: 'turn.completed', threadId: 'child2' })
    event({ type: 'status', threadId: 'child2', status: 'idle' })
    await vi.advanceTimersByTimeAsync(0)
    expect(adapter.sent.filter((s) => s.text === limitResumeTurn()).map((s) => s.threadId)).toEqual(['child1'])
  })

  it('sends no failure update when its agent exits on the limit', async () => {
    task('child1')
    limit('child1', 120 * MIN)
    await vi.waitFor(() => expect(wakes()).toHaveLength(1))
    // The CLI exits after the limit: the session ends with an error of its own.
    event({ type: 'status', threadId: 'child1', status: 'error' })
    await vi.advanceTimersByTimeAsync(10)
    // The absence of the failure is the point: a repeated Limited row would
    // be noise, not the false failure this covers.
    expect(wakes().map((w) => w.kind)).not.toContain('failed')
    expect(registry.hubView('parent1').children.find((c) => c.chat.id === 'child1')).toMatchObject({
      state: 'limited',
      limit: 'armed',
    })
  })

  it('reports a crash that comes long after the limit', async () => {
    task('child1')
    event({ type: 'status', threadId: 'child1', status: 'running', newTurn: true })
    event({
      type: 'turn.completed',
      threadId: 'child1',
      limit: { limitClass: 'usage_limit', resetAt: Date.now() + 120 * MIN },
    })
    event({ type: 'status', threadId: 'child1', status: 'idle' })
    await vi.waitFor(() => expect(wakes()).toHaveLength(1))
    // Minutes later the agent dies while the child waits for the reset.
    await vi.advanceTimersByTimeAsync(5 * MIN)
    event({ type: 'status', threadId: 'child1', status: 'error' })
    await vi.waitFor(() => expect(wakes().map((w) => w.kind)).toContain('failed'))
  })
})

describe('Resume on a child row', () => {
  it("sends a stopped child Switchboard's own resume turn, not a user message", async () => {
    task('child1')
    expect(await host.invoke(ProviderChannels.HUB_RESUME_CHILD, 'parent1', 'child1')).toEqual({ ok: true })
    expect(adapter.sent.filter((s) => s.text === hubResumeTurn()).map((s) => s.threadId)).toEqual(['child1'])
    expect(registry.hubView('parent1').children.find((c) => c.chat.id === 'child1')).toMatchObject({
      state: 'working',
    })
  })

  it('takes the auto-resume path for a limited child, and refuses a chat that is not a child', async () => {
    limit()
    await vi.waitFor(() => expect(wakes()).toHaveLength(1))
    expect(await host.invoke(ProviderChannels.HUB_RESUME_CHILD, 'parent1', 'child1')).toEqual({ ok: true })
    expect(adapter.sent.filter((s) => s.text === limitResumeTurn()).map((s) => s.threadId)).toEqual(['child1'])
    expect(adapter.sent.some((s) => s.text === hubResumeTurn())).toBe(false)
    await expect(host.invoke(ProviderChannels.HUB_RESUME_CHILD, 'parent1', 'someone')).rejects.toThrow(
      /not an open child/,
    )
  })

  it('says a child that already works needs no resume', async () => {
    event({ type: 'status', threadId: 'child1', status: 'running', newTurn: true })
    expect(await host.invoke(ProviderChannels.HUB_RESUME_CHILD, 'parent1', 'child1')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/already working/),
    })
  })
})

describe('move_child', () => {
  it('moves a limited child to another account of its agent, and clears its limit', async () => {
    limit()
    await vi.waitFor(() => expect(wakes()).toHaveLength(1))
    expect(registry.hubView('parent1').children.find((c) => c.chat.id === 'child1')).toMatchObject({
      state: 'limited',
      lastWake: { kind: 'limited' },
    })
    const result = await move('child1', 'claude-b')
    expect(text(result)).toMatch(/^Moved Child 1 from Claude A to Claude B\./)
    expect(result.isError).toBeFalsy()
    expect(getLimitResume('child1')).toMatchObject({ state: 'disarmed', disarmReason: 'moved' })
    expect(getConversationProviderInstanceId('child1')).toBe('claude-b')
    expect(getHubChild('child1')?.providerInstanceId).toBe('claude-b')
    expect(adapter.starts.at(-1)).toMatchObject({ threadId: 'child1', instanceId: 'claude-b' })
    expect(adapter.sent.filter((s) => s.text === limitResumeTurn()).map((s) => s.threadId)).toEqual(['child1'])
    expect(host.saved.map((r) => r.content)).toEqual(
      expect.arrayContaining([
        '[[sb:instance-rotated]] Claude A → Claude B',
        expect.stringMatching(/^\[\[sb:hub-update\]\] .*Moved from Claude A to Claude B\./),
      ]),
    )

    // The limit is old news once the child runs again: its row reads Working alone.
    expect(registry.hubView('parent1').children.find((c) => c.chat.id === 'child1')).toMatchObject({
      state: 'working',
      lastWake: null,
    })
    // The update itself is kept for the parent.
    expect(wakes().map((w) => w.kind)).toEqual(['limited'])

    // It is no longer limited, so it is free to move again at its next boundary.
    event({ type: 'turn.completed', threadId: 'child1' })
    event({ type: 'status', threadId: 'child1', status: 'idle' })
    expect(getLimitResume('child1')?.state).toBe('disarmed')
    expect(text(await move('child1', 'claude-a'))).toMatch(/^Moved Child 1 from Claude B to Claude A\./)
  })

  it('refuses another agent, a limited target, an unknown child and plan mode', async () => {
    limit()
    expect(text(await move('child1', 'codex-a'))).toMatch(/interrupt_child, then start_children/)
    usage.closed.add('claude-b')
    expect(text(await move('child1', 'claude-b'))).toMatch(/Claude B is at its usage limit too/)
    usage.closed.clear()
    expect(text(await move('someone', 'claude-b'))).toMatch(/not an open child/)
    adapter.mode = 'plan'
    expect(text(await move('child1', 'claude-b'))).toMatch(/Plan mode/)
    expect(getLimitResume('child1')?.state).toBe('armed')
  })

  it('moves a child that no limit stopped, and resumes it without the limit text', async () => {
    expect(text(await move('child1', 'claude-b'))).toMatch(/^Moved Child 1 from Claude A to Claude B\./)
    expect(getConversationProviderInstanceId('child1')).toBe('claude-b')
    expect(adapter.sent.filter((s) => s.text === hubResumeTurn()).map((s) => s.threadId)).toEqual(['child1'])
    expect(adapter.sent.some((s) => s.text === limitResumeTurn())).toBe(false)
    // No limit, so no move is spent: it can move again at its next boundary.
    expect(getHubChild('child1')?.movedAfterLimitTurnId).toBeNull()
    event({ type: 'turn.completed', threadId: 'child1' })
    event({ type: 'status', threadId: 'child1', status: 'idle' })
    expect(text(await move('child1', 'claude-a'))).toMatch(/^Moved Child 1 from Claude B to Claude A\./)
  })

  it('waits for the end of a running turn instead of interrupting it', async () => {
    event({ type: 'status', threadId: 'child1', status: 'running', newTurn: true })
    expect(text(await move('child1', 'claude-b'))).toMatch(/moves to Claude B when that turn ends/)
    expect(getConversationProviderInstanceId('child1')).not.toBe('claude-b')

    event({ type: 'turn.completed', threadId: 'child1' })
    event({ type: 'status', threadId: 'child1', status: 'idle' })
    await vi.waitFor(() => expect(getConversationProviderInstanceId('child1')).toBe('claude-b'))
    expect(adapter.starts.at(-1)).toMatchObject({ threadId: 'child1', instanceId: 'claude-b' })
    expect(adapter.sent.filter((s) => s.text === hubResumeTurn()).map((s) => s.threadId)).toEqual(['child1'])
  })

  it('waits for a turn that starts while the target account is being read', async () => {
    usage.duringFetch = () => {
      usage.duringFetch = null
      event({ type: 'status', threadId: 'child1', status: 'running', newTurn: true })
    }
    expect(text(await move('child1', 'claude-b'))).toMatch(/moves to Claude B when that turn ends/)
    expect(getConversationProviderInstanceId('child1')).not.toBe('claude-b')
    event({ type: 'turn.completed', threadId: 'child1' })
    event({ type: 'status', threadId: 'child1', status: 'idle' })
    await vi.waitFor(() => expect(getConversationProviderInstanceId('child1')).toBe('claude-b'))
  })

  it('drops a queued move when the child stops before its turn ends', async () => {
    event({ type: 'status', threadId: 'child1', status: 'running', newTurn: true })
    expect(text(await move('child1', 'claude-b'))).toMatch(/moves to Claude B when that turn ends/)
    await host.invoke(ProviderChannels.HUB_STOP_CHILDREN, 'parent1', 'child1')
    event({ type: 'turn.completed', threadId: 'child1' })
    event({ type: 'status', threadId: 'child1', status: 'idle' })
    await vi.advanceTimersByTimeAsync(50)
    expect(getConversationProviderInstanceId('child1')).not.toBe('claude-b')
  })

  it('moves a limited child that holds a message queued behind its stopped turn', async () => {
    // The turn runs, the parent queues a message behind it, and the usage
    // limit ends the turn. The queued message stays counted as an outstanding
    // turn, and no turn runs any more: the move must happen now, not wait.
    event({ type: 'status', threadId: 'child1', status: 'running', newTurn: true })
    const sendToChild = mcp.opened.get('parent1')!.find((t) => t.name === 'send_agent_message')!
    await sendToChild.call({ sessionId: 'child1', message: 'one more thing', delivery: 'queue' })
    event({
      type: 'turn.completed',
      threadId: 'child1',
      limit: { limitClass: 'usage_limit', resetAt: Date.now() + 2 * MIN },
    })
    event({ type: 'status', threadId: 'child1', status: 'idle' })
    await vi.waitFor(() => expect(wakes()).toHaveLength(1))

    const sentBefore = adapter.sent.length
    const result = text(await move('child1', 'claude-b'))
    expect(result).toMatch(/^Moved Child 1 from Claude A to Claude B\./)
    expect(result).toMatch(/The 1 message it held came with it\./)
    expect(getConversationProviderInstanceId('child1')).toBe('claude-b')
    // The queued message comes with it: the resume turn goes out on the new
    // account and the message the child never read follows it.
    const after = adapter.sent.slice(sentBefore)
    expect(after[0]).toMatchObject({ threadId: 'child1', text: limitResumeTurn() })
    expect(after.at(-1)!.text).toContain('one more thing')
    expect(adapter.resumedQueues).toContain('child1')
  })

  it('moves a child off a nearly full account at its turn boundary, and leaves a child that reported', async () => {
    setSetting('hub.autoMoveAtPercent', '80')
    usage.percent.set('claude-a', 92)
    usage.percent.set('claude-b', 20)
    // A turn of its own ends: the account is over the percent, so the child moves.
    event({ type: 'status', threadId: 'child1', status: 'running', newTurn: true })
    event({ type: 'turn.completed', threadId: 'child1' })
    event({ type: 'status', threadId: 'child1', status: 'idle' })
    await vi.waitFor(() => expect(getConversationProviderInstanceId('child1')).toBe('claude-b'))

    // child2 reports instead: it waits to be settled, so the auto-move leaves it.
    usage.percent.set('claude-a', 95)
    event({ type: 'status', threadId: 'child2', status: 'running', newTurn: true })
    await mcp.opened
      .get('child2')!
      .find((t) => t.name === 'report_to_hub')!
      .call({ status: 'done', summary: 'All of it is done.' })
    event({ type: 'turn.completed', threadId: 'child2' })
    event({ type: 'status', threadId: 'child2', status: 'idle' })
    await vi.advanceTimersByTimeAsync(50)
    expect(getConversationProviderInstanceId('child2')).not.toBe('claude-b')

    // It is back at work: the report is old news, so the next boundary moves it.
    event({ type: 'status', threadId: 'child2', status: 'running', newTurn: true })
    event({ type: 'turn.completed', threadId: 'child2' })
    event({ type: 'status', threadId: 'child2', status: 'idle' })
    await vi.waitFor(() => expect(getConversationProviderInstanceId('child2')).toBe('claude-b'))
  })

  it('runs a queued move when the agent exits on a usage limit instead of going idle', async () => {
    event({ type: 'status', threadId: 'child1', status: 'running', newTurn: true })
    expect(text(await move('child1', 'claude-b'))).toMatch(/moves to Claude B when that turn ends/)
    // The turn ends on the limit and the agent leaves: no idle ever comes.
    event({
      type: 'turn.completed',
      threadId: 'child1',
      limit: { limitClass: 'usage_limit', resetAt: Date.now() + 120 * MIN },
    })
    event({ type: 'status', threadId: 'child1', status: 'error' })
    await vi.waitFor(() => expect(getConversationProviderInstanceId('child1')).toBe('claude-b'))
  })

  it('refuses a target with no free run slot', async () => {
    setSetting('hub.runningPerInstance', '1')
    await host.invoke(ProviderChannels.STOP_SESSION, 'child2')
    await host.invoke(ProviderChannels.START_SESSION, {
      threadId: 'child2',
      provider: 'claude',
      cwd: TMP,
      instanceId: 'claude-b',
    })
    event({ type: 'status', threadId: 'child2', status: 'running', newTurn: true })
    limit()
    expect(text(await move('child1', 'claude-b'))).toMatch(/no free slot/)
  })
})
