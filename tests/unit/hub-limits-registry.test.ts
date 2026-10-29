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

const usage = vi.hoisted(() => ({ closed: new Set<string>() }))
vi.mock('../../src/main/provider/usage', () => ({
  fetchInstanceUsage: async (instanceId: string) => ({
    instanceId,
    agentType: 'claude-code',
    status: 'ok',
    plan: null,
    account: null,
    windows: usage.closed.has(instanceId)
      ? [
          {
            id: 's',
            label: '5-hour session',
            kind: 'session',
            usedPercent: 100,
            resetsAtMs: Date.now() + 60 * 60_000,
            windowMinutes: 300,
            severity: 'critical',
          },
        ]
      : [],
    overage: [],
    fetchedAtMs: Date.now(),
  }),
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
  async sendTurn(threadId: string, text: string): Promise<void> {
    this.sent.push({ threadId, text: stripSenderLine(text) })
    this.emit.get(threadId)?.({ type: 'status', threadId, status: 'running' })
  }
  async resumeQueuedTurns(): Promise<boolean> {
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
/** The child's turn runs, then ends on a usage limit that resets in 2 minutes. */
function limit(childId = 'child1') {
  event({ type: 'status', threadId: childId, status: 'running', newTurn: true })
  event({
    type: 'turn.completed',
    threadId: childId,
    limit: { limitClass: 'usage_limit', resetAt: Date.now() + 2 * MIN },
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
})

describe('move_child', () => {
  it('moves a limited child to another account of its agent, once per limit', async () => {
    limit()
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

    // The resumed turn hits the limit of Claude B: still the same move budget until a new limit.
    event({ type: 'status', threadId: 'child1', status: 'idle' })
    expect(text(await move('child1', 'claude-a'))).toMatch(/not stopped by a usage limit/)
  })

  it('refuses another agent, a limited target, a child that is not limited, and plan mode', async () => {
    expect(text(await move('child1', 'claude-b'))).toMatch(/not stopped by a usage limit/)
    limit()
    expect(text(await move('child1', 'codex-a'))).toMatch(/interrupt_child, then start_children/)
    usage.closed.add('claude-b')
    expect(text(await move('child1', 'claude-b'))).toMatch(/Claude B is at its usage limit too/)
    usage.closed.clear()
    expect(text(await move('someone', 'claude-b'))).toMatch(/not an open child/)
    event({ type: 'status', threadId: 'child1', status: 'running' })
    expect(text(await move('child1', 'claude-b'))).toMatch(/runs a turn or holds queued messages/)
    event({ type: 'status', threadId: 'child1', status: 'idle' })
    adapter.mode = 'plan'
    expect(text(await move('child1', 'claude-b'))).toMatch(/Plan mode/)
    expect(getLimitResume('child1')?.state).toBe('armed')
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
