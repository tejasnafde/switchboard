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
  getSetting: (key: string) => (key === 'labs.hub_children' ? 'true' : null),
  getConversationExecutionRoot: () => null,
  commitConversationExecutionRoot: () => {},
  commitConversationProviderSwitch: () => {},
  getDb: () => ({}),
  deleteUserMessage: () => {},
  isConversationArchived: () => false,
  // hub_children, as one open child: the SQL is covered by hub-db.test.ts.
  openChildParentId: (id: string) => (id === 'child1' ? 'parent1' : null),
}))

import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import type { BackendHost } from '../../src/main/backend/host'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent } from '../../src/shared/provider-events'
import type { SwitchboardMcpServer } from '../../src/main/mcp/switchboard-mcp-server'
import type { McpTool } from '../../src/main/mcp/mcp-session'
import { CHILD_READ_ONLY_CODE } from '../../src/shared/hub'

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
  })
})
