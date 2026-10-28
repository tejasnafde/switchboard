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
  getProviderInstanceFull: (id: string) => ({
    id,
    agentType: 'claude-code',
    displayName: id,
    enabled: true,
    env: {},
    oauthDir: null,
  }),
  listOauthDirsForAgent: () => [],
}))

vi.mock('../../src/main/provider/remote-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/remote-gate')>()
  return { ...actual, remoteProviderLoginPrompt: () => null }
})

const hubFlag = vi.hoisted(() => ({ on: true, wakes: [] as Array<Record<string, unknown>> }))

vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: () => {},
  recordConversationSegment: () => {},
  updateConversationSessionId: () => {},
  saveMessageIfAbsent: () => true,
  getConversationById: (id: string) => ({ id, project_path: '/tmp' }),
  getConversationTitle: () => null,
  resolveRootThreadId: (id: string) => id,
  getConversationRuntimeMode: () => null,
  getConversationModel: () => null,
  getConversationReasoningEffort: () => null,
  getConversationAgentType: () => null,
  getConversationProviderInstanceId: () => null,
  getSetting: (key: string) => (key === 'labs.hub_children' && hubFlag.on ? 'true' : null),
  getConversationExecutionRoot: () => null,
  commitConversationExecutionRoot: () => {},
  commitConversationProviderSwitch: () => {},
  getDb: () => ({}),
  deleteUserMessage: () => {},
  isConversationArchived: () => false,
  // hub_children, as one open child: the SQL is covered by hub-db.test.ts.
  openChildParentId: (id: string) => (id === 'child1' ? 'parent1' : null),
  threadFamilyIds: (id: string) => [id],
  listHubChildren: (id: string) =>
    id === 'parent1'
      ? [
          {
            childId: 'child1',
            parentId: 'parent1',
            title: 'Usage export',
            phase: 'open',
            providerInstanceId: 'claude-work',
            branch: 'hub/usage-export-1',
          },
        ]
      : [],
  lastHubWakes: () => new Map(),
  listPendingHubWakes: () => [],
  listParentsWithPendingHubWakes: () => [],
  insertHubWake: (w: Record<string, unknown>) => hubFlag.wakes.push(w),
  getHubParent: () => null,
}))

import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { COMPACTING_NOTICE, compactingNoticeId } from '../../src/main/provider/claude-prompt-too-long'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import type { BackendHost } from '../../src/main/backend/host'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent } from '../../src/shared/provider-events'
import type { SwitchboardMcpServer } from '../../src/main/mcp/switchboard-mcp-server'
import type { McpTool } from '../../src/main/mcp/mcp-session'
import { CHILD_READ_ONLY_CODE, EMPTY_HUB_VIEW, type HubChatView } from '../../src/shared/hub'

class FakeHost implements BackendHost {
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn)
  }
  on(): void {}
  emitted: unknown[][] = []
  emit(...args: unknown[]): void {
    this.emitted.push(args)
  }
  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    const fn = this.handlers.get(channel)
    if (!fn) throw new Error(`no handler registered for ${channel}`)
    return (await fn(...args)) as T
  }
}

class Adapter implements ProviderAdapter {
  readonly provider = 'claude' as const
  onEvent!: (e: RuntimeEvent) => void
  calls: string[] = []
  async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    this.onEvent = onEvent
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
    _threadId: string,
    message: string,
    _mode?: unknown,
    _images?: unknown,
    delivery?: string,
  ): Promise<void> {
    this.calls.push(`send:${delivery ?? 'turn'}:${message}`)
  }
  async respondToRequest(): Promise<void> {}
  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async setRuntimeMode(): Promise<void> {}
  async isAvailable(): Promise<boolean> {
    return true
  }
  async resumeQueuedTurns(): Promise<boolean> {
    this.calls.push('resume-queue')
    return true
  }
}

/** Records the tools and instructions each chat's MCP server would serve. */
function fakeMcp() {
  const opened = new Map<string, { tools: McpTool[]; instructions?: string }>()
  const server = {
    async open(threadId: string, tools: () => McpTool[], instructions?: string) {
      opened.set(threadId, { tools: tools(), instructions })
      return { command: 'node', args: [], env: {} }
    },
    close() {},
    agentPid: () => null,
  }
  return { opened, server: server as unknown as SwitchboardMcpServer }
}

function setup() {
  const host = new FakeHost()
  const mcp = fakeMcp()
  const registry = new ProviderRegistry(host, new Map([['claude', new Adapter()]]), undefined, undefined, mcp.server)
  registry.registerIpcHandlers()
  return { host, mcp }
}

describe('child chats in the registry', () => {
  it('refuses a user turn to an open child on both turn channels', async () => {
    const { host } = setup()
    await host.invoke(ProviderChannels.START_SESSION, { threadId: 'child1', provider: 'claude', cwd: '/tmp' })
    const result = await host.invoke<Record<string, unknown>>(ProviderChannels.SUBMIT_USER_TURN, {
      version: 1,
      threadId: 'child1',
      origin: 'o1',
      providerText: 'hi',
    })
    expect(result).toMatchObject({ status: 'rejected', code: CHILD_READ_ONLY_CODE })
    await expect(host.invoke(ProviderChannels.SEND_TURN, 'child1', 'hi')).rejects.toThrow('Message the hub')
  })

  it('gives the parent tools and the hub paragraph to a chat that is not a child, and none to a child', async () => {
    const { host, mcp } = setup()
    await host.invoke(ProviderChannels.START_SESSION, { threadId: 'parent1', provider: 'claude', cwd: '/tmp' })
    await host.invoke(ProviderChannels.START_SESSION, { threadId: 'child1', provider: 'claude', cwd: '/tmp' })
    const names = (id: string) => mcp.opened.get(id)!.tools.map((t) => t.name)
    expect(names('parent1')).toEqual(expect.arrayContaining(['start_children', 'list_children']))
    expect(mcp.opened.get('parent1')!.instructions).toContain('start_children')
    expect(names('child1')).not.toContain('start_children')
    expect(names('child1')).not.toContain('list_children')
    expect(mcp.opened.get('child1')!.instructions).toBeUndefined()
    expect(names('child1')).toContain('own_dependencies')
    expect(names('parent1')).not.toContain('own_dependencies')
    expect(names('parent1')).toContain('read_child')
    expect(names('child1')).not.toContain('read_child')
    expect(names('child1')).toContain('report_to_hub')
    expect(names('parent1')).not.toContain('report_to_hub')
  })

  it('stores a report as a wake for the parent, pointing at the tool call', async () => {
    const adapter = new Adapter()
    const host = new FakeHost()
    const mcp = fakeMcp()
    new ProviderRegistry(host, new Map([['claude', adapter]]), undefined, undefined, mcp.server).registerIpcHandlers()
    await host.invoke(ProviderChannels.START_SESSION, { threadId: 'child1', provider: 'claude', cwd: '/tmp' })
    adapter.onEvent({
      type: 'tool.started',
      threadId: 'child1',
      toolId: 'toolu_42',
      toolName: 'mcp__switchboard__report_to_hub',
      input: {},
    })
    const report = mcp.opened.get('child1')!.tools.find((t) => t.name === 'report_to_hub')!
    hubFlag.wakes.length = 0
    const result = await report.call({ status: 'done', summary: 'Export works.', report: 'Long report' })
    expect(result.isError).toBeFalsy()
    expect(hubFlag.wakes).toEqual([
      expect.objectContaining({
        parentId: 'parent1',
        childId: 'child1',
        kind: 'report',
        summary: 'Export works.',
        pointer: expect.objectContaining({ childId: 'child1', toolCallId: 'toolu_42' }),
      }),
    ])
    // The report body stays in the child's transcript.
    expect(JSON.stringify(hubFlag.wakes)).not.toContain('Long report')
  })

  it('gives two reports started in one message their own tool calls, in order', async () => {
    const adapter = new Adapter()
    const host = new FakeHost()
    const mcp = fakeMcp()
    new ProviderRegistry(host, new Map([['claude', adapter]]), undefined, undefined, mcp.server).registerIpcHandlers()
    await host.invoke(ProviderChannels.START_SESSION, { threadId: 'child1', provider: 'claude', cwd: '/tmp' })
    for (const toolId of ['toolu_1', 'toolu_2'])
      adapter.onEvent({
        type: 'tool.started',
        threadId: 'child1',
        toolId,
        toolName: 'mcp__switchboard__report_to_hub',
        input: {},
      })
    const report = mcp.opened.get('child1')!.tools.find((t) => t.name === 'report_to_hub')!
    hubFlag.wakes.length = 0
    await report.call({ status: 'done', summary: 'First.' })
    await report.call({ status: 'done', summary: 'Second.' })
    expect(hubFlag.wakes.map((w) => (w.pointer as { toolCallId?: string }).toolCallId)).toEqual(['toolu_1', 'toolu_2'])
  })

  it('does not count the compaction notice as output of the agent on a wake turn', async () => {
    const adapter = new Adapter()
    const host = new FakeHost()
    const registry = new ProviderRegistry(host, new Map([['claude', adapter]]), undefined, undefined, fakeMcp().server)
    registry.registerIpcHandlers()
    await host.invoke(ProviderChannels.START_SESSION, { threadId: 'parent1', provider: 'claude', cwd: '/tmp' })
    const activity = vi.spyOn(registry.hubWakes, 'onActivity')
    adapter.onEvent({
      type: 'content',
      threadId: 'parent1',
      messageId: compactingNoticeId(1),
      text: COMPACTING_NOTICE,
      streamKind: 'reasoning',
    })
    expect(activity).not.toHaveBeenCalled()
    adapter.onEvent({ type: 'content', threadId: 'parent1', messageId: 'm1', text: 'On it.', streamKind: 'assistant' })
    expect(activity).toHaveBeenCalledWith('parent1')
  })
})

describe('the hub view', () => {
  it('shows a parent its children with their state, and a child its parent', async () => {
    hubFlag.on = true
    const { host } = setup()
    await host.invoke(ProviderChannels.START_SESSION, { threadId: 'child1', provider: 'claude', cwd: '/tmp' })
    const parent = await host.invoke<HubChatView>(ProviderChannels.HUB_LIST_CHILDREN, 'parent1')
    expect(parent.self?.id).toBe('parent1')
    expect(parent.parent).toBeNull()
    expect(parent.children).toHaveLength(1)
    expect(parent.children[0]).toMatchObject({
      chat: { id: 'child1' },
      liveId: 'child1',
      state: 'paused',
      account: 'claude-work',
      branch: 'hub/usage-export-1',
    })
    expect(parent.state).toBe('idle')

    const child = await host.invoke<HubChatView>(ProviderChannels.HUB_LIST_CHILDREN, 'child1')
    expect(child.self?.id).toBe('child1')
    expect(child.parent?.id).toBe('parent1')
    expect(child.children).toEqual([])

    expect(await host.invoke(ProviderChannels.HUB_LIST_CHILDREN, 'other')).toEqual(EMPTY_HUB_VIEW)
  })

  it("tells clients to re-read the parent when a child's status changes, and shows it working", async () => {
    hubFlag.on = true
    const host = new FakeHost()
    const adapter = new Adapter()
    const registry = new ProviderRegistry(host, new Map([['claude', adapter]]), undefined, undefined, fakeMcp().server)
    registry.registerIpcHandlers()
    const events: RuntimeEvent[] = []
    registry.bus.subscribe((e) => events.push(e))
    await host.invoke(ProviderChannels.START_SESSION, { threadId: 'child1', provider: 'claude', cwd: '/tmp' })
    adapter.onEvent({ type: 'status', threadId: 'child1', status: 'running' })
    // Claude repeats running on each tool call: only the change counts.
    adapter.onEvent({ type: 'status', threadId: 'child1', status: 'running' })
    expect(events.filter((e) => e.type === 'hub.children-changed')).toEqual([
      { type: 'hub.children-changed', threadId: 'parent1' },
    ])
    const parent = await host.invoke<HubChatView>(ProviderChannels.HUB_LIST_CHILDREN, 'parent1')
    expect(parent.children[0].state).toBe('working')
    expect(parent.state).toBe('waiting')
  })

  it('is empty with the flag off', async () => {
    hubFlag.on = false
    try {
      const { host } = setup()
      expect(await host.invoke(ProviderChannels.HUB_LIST_CHILDREN, 'parent1')).toEqual(EMPTY_HUB_VIEW)
      expect(await host.invoke(ProviderChannels.HUB_LIST_CHILDREN, 'child1')).toEqual(EMPTY_HUB_VIEW)
    } finally {
      hubFlag.on = true
    }
  })
})
