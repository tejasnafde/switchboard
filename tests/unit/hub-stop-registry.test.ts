/**
 * Stopping child chats against the real registry: Stop on a parent stops its
 * children in parallel and holds its updates, a per-child Stop and
 * `interrupt_child` stop one, Switchboard writes the stopped, failed and
 * blocked wakes, native subagents keep a child Working, and a reaped child
 * starts again for its parent's message.
 */
import { describe, expect, it, vi } from 'vitest'
import './helpers/registry-session-mocks'

vi.mock('../../src/main/db/provider-instances', () => ({
  resolveProviderInstance: (agentType: string, id?: string) => ({
    id: id ?? `${agentType}-default`,
    agentType,
    displayName: id ?? `${agentType}-default`,
    enabled: true,
    env: {},
    oauthDir: null,
  }),
  getProviderInstanceFull: () => null,
  listOauthDirsForAgent: () => [],
}))

vi.mock('../../src/main/provider/remote-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/remote-gate')>()
  return { ...actual, remoteProviderLoginPrompt: () => null }
})

const db = vi.hoisted(() => ({
  children: [] as Array<{ childId: string; parentId: string; title: string; phase: string }>,
  wakes: [] as Array<Record<string, unknown>>,
  held: new Map<string, string | null>(),
}))

vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: () => {},
  recordConversationSegment: () => {},
  updateConversationSessionId: () => {},
  saveMessageIfAbsent: () => true,
  rewriteSystemMarker: () => null,
  getConversationById: (id: string) => ({ id, project_path: process.cwd() }),
  getConversationTitle: () => null,
  resolveRootThreadId: (id: string) => id,
  getConversationRuntimeMode: () => null,
  getConversationModel: () => null,
  getConversationReasoningEffort: () => null,
  getConversationAgentType: () => null,
  getConversationProviderInstanceId: () => null,
  getSetting: (key: string) => (key === 'labs.hub_children' ? 'true' : null),
  getConversationExecutionRoot: () => null,
  commitConversationExecutionRoot: () => {},
  commitConversationProviderSwitch: () => {},
  getDb: () => ({}),
  deleteUserMessage: () => {},
  isConversationArchived: () => false,
  openChildParentId: (id: string) => db.children.find((c) => c.childId === id)?.parentId ?? null,
  listHubChildrenInPhase: (phase: string) => db.children.filter((c) => c.phase === phase),
  listHubChildren: (parentId: string) => db.children.filter((c) => c.parentId === parentId),
  getHubChild: (id: string) => db.children.find((c) => c.childId === id) ?? null,
  threadFamilyIds: (id: string) => [id],
  lastHubWakes: () => new Map(),
  listPendingHubWakes: () => [],
  listParentsWithPendingHubWakes: () => [],
  insertHubWake: (w: Record<string, unknown>) => db.wakes.push(w),
  getHubParent: (id: string) =>
    db.held.has(id) ? { parentId: id, held: true, heldReason: db.held.get(id), heldAt: 0 } : null,
  setHubParentHeld: (id: string, held: boolean, reason: string | null = null) => {
    if (held) db.held.set(id, reason)
    else db.held.delete(id)
  },
}))

import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import type { BackendHost } from '../../src/main/backend/host'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent, RuntimeMode } from '../../src/shared/provider-events'
import type { SwitchboardMcpServer } from '../../src/main/mcp/switchboard-mcp-server'
import type { McpTool } from '../../src/main/mcp/mcp-session'

class FakeHost implements BackendHost {
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn)
  }
  on(): void {}
  emit(): void {}
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
  interrupted: string[] = []
  mode: RuntimeMode = 'full-access'
  /** How long an interrupt takes, so a serial cascade would show. */
  interruptMs = 0
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
  async sendTurn(): Promise<void> {}
  async respondToRequest(): Promise<void> {}
  async interruptTurn(threadId: string): Promise<void> {
    await new Promise((r) => setTimeout(r, this.interruptMs))
    this.interrupted.push(threadId)
    this.emit.get(threadId)?.({ type: 'turn.completed', threadId })
    this.emit.get(threadId)?.({ type: 'status', threadId, status: 'idle' })
  }
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

async function setup(childCount = 2) {
  db.children = Array.from({ length: childCount }, (_, i) => ({
    childId: `child${i + 1}`,
    parentId: 'parent1',
    title: `Child ${i + 1}`,
    phase: 'open',
  }))
  db.wakes.length = 0
  db.held.clear()
  const host = new FakeHost()
  const adapter = new Adapter()
  const mcp = fakeMcp()
  const registry = new ProviderRegistry(host, new Map([['claude', adapter]]), undefined, undefined, mcp.server)
  registry.registerIpcHandlers()
  for (const threadId of ['parent1', ...db.children.map((c) => c.childId)])
    await host.invoke(ProviderChannels.START_SESSION, { threadId, provider: 'claude', cwd: process.cwd() })
  const busy = (threadId: string) =>
    adapter.emit.get(threadId)!({ type: 'status', threadId, status: 'running', newTurn: true })
  const event = (e: RuntimeEvent) => adapter.emit.get(e.threadId)!(e)
  /** The child got its brief, or a message from its parent. */
  const task = (childId: string) => registry['hubNotes'].task(childId)
  const tool = (threadId: string, name: string) => mcp.opened.get(threadId)!.find((t) => t.name === name)!
  return { host, adapter, registry, busy, event, task, tool }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('Stop on a parent', () => {
  it('stops 6 running children in parallel, holds the parent and tells it each child stopped', async () => {
    const { host, adapter, busy } = await setup(6)
    adapter.interruptMs = 40
    for (let i = 1; i <= 6; i++) busy(`child${i}`)
    const started = Date.now()
    await host.invoke(ProviderChannels.INTERRUPT, 'parent1')
    // Serially this would take 240 ms.
    expect(Date.now() - started).toBeLessThan(200)
    expect(adapter.interrupted.filter((id) => id !== 'parent1').sort()).toEqual([
      'child1',
      'child2',
      'child3',
      'child4',
      'child5',
      'child6',
    ])
    expect(db.held.get('parent1')).toBe('stop')
    await vi.waitFor(() => expect(db.wakes).toHaveLength(6))
    expect(db.wakes.every((w) => w.kind === 'stopped' && w.summary === 'Stopped with this chat.')).toBe(true)
  })

  it('holds the parent and stops nothing more when no child runs', async () => {
    const { host, adapter } = await setup()
    await host.invoke(ProviderChannels.INTERRUPT, 'parent1')
    expect(adapter.interrupted).toEqual(['parent1'])
    expect(db.held.get('parent1')).toBe('stop')
    await settle()
    expect(db.wakes).toEqual([])
  })

  it('stops all children from the strip channel, and refuses a child of another chat', async () => {
    const { host, adapter, busy } = await setup()
    busy('child1')
    await host.invoke(ProviderChannels.HUB_STOP_CHILDREN, 'parent1')
    expect(adapter.interrupted).toEqual(['child1'])
    await expect(host.invoke(ProviderChannels.HUB_STOP_CHILDREN, 'other', 'child2')).rejects.toThrow(
      /not an open child/,
    )
  })
})

describe('Stop on one child', () => {
  it('stops a running child with one stopped wake, and stopping it again is a quiet success', async () => {
    const { host, adapter, busy, task } = await setup()
    task('child1')
    busy('child1')
    expect(await host.invoke(ProviderChannels.INTERRUPT, 'child1')).toEqual({ live: true })
    await vi.waitFor(() => expect(db.wakes).toHaveLength(1))
    expect(db.wakes[0]).toMatchObject({
      parentId: 'parent1',
      childId: 'child1',
      kind: 'stopped',
      summary: 'Stopped by the user.',
    })
    expect(await host.invoke(ProviderChannels.INTERRUPT, 'child1')).toEqual({ live: false })
    await settle()
    // The interrupt's own turn end did not add "without a report".
    expect(db.wakes).toHaveLength(1)
    expect(adapter.interrupted).toEqual(['child1'])
    expect(db.held.size).toBe(0)
  })

  it('stops a child that runs only a background subagent', async () => {
    const { host, adapter, event, task } = await setup()
    task('child1')
    event({ type: 'tool.started', threadId: 'child1', toolId: 'ag1', toolName: 'Agent', input: {} })
    event({ type: 'tool.completed', threadId: 'child1', toolId: 'ag1', output: 'Async agent launched successfully.' })
    event({ type: 'turn.completed', threadId: 'child1' })
    event({ type: 'status', threadId: 'child1', status: 'idle' })
    expect(await host.invoke(ProviderChannels.INTERRUPT, 'child1')).toEqual({ live: true })
    expect(adapter.interrupted).toEqual(['child1'])
    await vi.waitFor(() => expect(db.wakes.map((w) => w.kind)).toEqual(['stopped']))
  })

  it('lets the parent stop its own child with interrupt_child, quietly, and not in plan mode', async () => {
    const { adapter, busy, tool } = await setup()
    const interrupt = tool('parent1', 'interrupt_child')
    busy('child1')
    expect((await interrupt.call({ childId: 'child1' })).content[0]).toMatchObject({ text: 'Stopped Child 1.' })
    expect((await interrupt.call({ childId: 'child1' })).content[0]).toMatchObject({
      text: 'Child 1 had no running turn.',
    })
    const other = await interrupt.call({ childId: 'someone-else' })
    expect(other.isError).toBe(true)
    adapter.mode = 'plan'
    expect((await interrupt.call({ childId: 'child2' })).isError).toBe(true)
    await settle()
    expect(db.wakes).toEqual([])
    expect(adapter.interrupted).toEqual(['child1'])
  })

  it('gives a child no interrupt_child', async () => {
    const { tool } = await setup()
    expect(tool('child1', 'interrupt_child')).toBeUndefined()
  })
})

describe("Switchboard's wakes for a child", () => {
  it('writes stopped when a turn ends without a report, once per task', async () => {
    const { event, task } = await setup()
    task('child1')
    event({ type: 'turn.completed', threadId: 'child1' })
    event({ type: 'turn.completed', threadId: 'child1' })
    await vi.waitFor(() => expect(db.wakes).toHaveLength(1))
    expect(db.wakes[0]).toMatchObject({ kind: 'stopped', summary: 'Ended its turn without a report.' })
    // No task in this process: nothing for child2.
    event({ type: 'turn.completed', threadId: 'child2' })
    await settle()
    expect(db.wakes).toHaveLength(1)
  })

  it('writes nothing after the child reported', async () => {
    const { event, task, tool } = await setup()
    task('child1')
    await tool('child1', 'report_to_hub').call({ status: 'done', summary: 'Done.' })
    event({ type: 'turn.completed', threadId: 'child1' })
    await settle()
    expect(db.wakes.map((w) => w.kind)).toEqual(['report'])
  })

  it('writes failed for a turn that ends on an error, blocked for a full context window, none for a usage limit', async () => {
    const { event, task } = await setup(3)
    task('child1')
    event({ type: 'error', threadId: 'child1', message: 'API error 500\nat line 3' })
    event({ type: 'turn.completed', threadId: 'child1' })
    // Adapters send the error before the end that carries the limit.
    task('child2')
    event({ type: 'error', threadId: 'child2', message: 'Prompt is too long' })
    event({ type: 'turn.completed', threadId: 'child2', limit: { limitClass: 'context_full', resetAt: null } })
    task('child3')
    event({ type: 'error', threadId: 'child3', message: 'Usage limit reached' })
    event({
      type: 'turn.completed',
      threadId: 'child3',
      limit: { limitClass: 'usage_limit', resetAt: Date.now() + 60_000 },
    })
    await vi.waitFor(() => expect(db.wakes).toHaveLength(2))
    await settle()
    expect(db.wakes).toEqual([
      expect.objectContaining({ childId: 'child1', kind: 'failed', summary: 'Failed: API error 500' }),
      expect.objectContaining({ childId: 'child2', kind: 'blocked' }),
    ])
  })

  it('writes nothing when a session Switchboard stops ends', async () => {
    const { host, event, task } = await setup()
    task('child1')
    await host.invoke(ProviderChannels.STOP_SESSION, 'child1')
    event({ type: 'status', threadId: 'child1', status: 'error' })
    await settle()
    expect(db.wakes).toEqual([])
  })
})

describe('native subagents of a child', () => {
  it('keep it Working after its turn ends, and its turn end is not a stop', async () => {
    const { host, event, task } = await setup()
    task('child1')
    event({ type: 'tool.started', threadId: 'child1', toolId: 'ag1', toolName: 'Agent', input: {} })
    event({ type: 'tool.completed', threadId: 'child1', toolId: 'ag1', output: 'Async agent launched successfully.' })
    event({ type: 'turn.completed', threadId: 'child1' })
    event({ type: 'status', threadId: 'child1', status: 'idle' })
    const view = await host.invoke<{ children: Array<{ chat: { id: string }; state: string }> }>(
      ProviderChannels.HUB_LIST_CHILDREN,
      'parent1',
    )
    expect(view.children.find((c) => c.chat.id === 'child1')?.state).toBe('working')
    await settle()
    expect(db.wakes).toEqual([])
  })
})

describe('a reaped child', () => {
  it('starts again from its session for its parent message', async () => {
    const { adapter, registry, event } = await setup()
    event({ type: 'session', threadId: 'child1', sessionId: 'sess-1' })
    await registry['hubReaperHost']().stop('child1', 'child1')
    expect(registry['sessionAdapters'].has('child1')).toBe(false)
    await registry.deliverPeerMessage({
      fromThreadId: 'parent1',
      targetThreadId: 'child1',
      text: 'One more thing.',
      initiator: 'agent',
    })
    expect(adapter.starts.filter((s) => s.threadId === 'child1').at(-1)).toMatchObject({ resumeSessionId: 'sess-1' })
    expect(registry['sessionAdapters'].has('child1')).toBe(true)
  })
})
