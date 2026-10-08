/**
 * The Switchboard MCP server end to end: the real stdio bridge, spawned the
 * way an agent spawns it, talking to an in-process backend.
 *
 * First against the server alone (handshake, token auth, revocation), then
 * through the provider registry: a session start hands the adapter the
 * launch, a reply tool call opens a card on the chat's event stream, a phone
 * cannot approve it, the desktop's edited text is what is posted, and
 * stopping the session revokes the token.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import './helpers/registry-session-mocks'

vi.setConfig({ testTimeout: 20_000 })

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
    agentType: 'codex',
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
  getConversationById: (id: string) => ({ id }),
  getConversationTitle: () => null,
  resolveRootThreadId: (id: string) => id,
  getConversationRuntimeMode: () => null,
  getConversationModel: () => null,
  getConversationAgentType: () => null,
  getConversationProviderInstanceId: () => null,
  getSetting: () => null,
  getConversationExecutionRoot: () => null,
  commitConversationExecutionRoot: () => {},
  commitConversationProviderSwitch: () => {},
  getDb: () => ({}),
}))

import { SwitchboardMcpServer, type SwitchboardMcpLaunch } from '../../src/main/mcp/switchboard-mcp-server'
import { toolText, type McpTool } from '../../src/main/mcp/mcp-session'
import { setAgentPullRequestAccess, type AgentPullRequestAccess } from '../../src/main/mcp/pr-tools'
import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { withBackendRequestContext } from '../../src/main/backend/request-context'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import { HOST_WRITE_SHOWN_REQUIRED, hostWriteShownDigest } from '../../src/shared/host-write-phone'
import type { BackendHost } from '../../src/main/backend/host'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent } from '../../src/shared/provider-events'
import type { PrRef } from '../../src/shared/pull-requests'

const bridgeDir = mkdtempSync(join(tmpdir(), 'sb-mcp-test-'))
afterAll(() => rmSync(bridgeDir, { recursive: true, force: true }))

/** A minimal MCP client over the bridge's stdio, as an agent would run it. */
class BridgeClient {
  readonly child: ChildProcessWithoutNullStreams
  readonly exited: Promise<number | null>
  private nextId = 1
  private waiting = new Map<number, (msg: Record<string, unknown>) => void>()

  constructor(launch: SwitchboardMcpLaunch) {
    this.child = spawn(launch.command, launch.args, {
      env: { ...process.env, ...launch.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.exited = new Promise((resolve) => this.child.on('exit', (code) => resolve(code)))
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      const msg = JSON.parse(line) as Record<string, unknown>
      this.waiting.get(msg.id as number)?.(msg)
    })
  }

  request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.waiting.set(id, resolve)
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  close(): void {
    this.child.stdin.end()
  }
}

const clients: BridgeClient[] = []
function connect(launch: SwitchboardMcpLaunch): BridgeClient {
  const client = new BridgeClient(launch)
  clients.push(client)
  return client
}
afterEach(() => {
  for (const c of clients.splice(0)) c.child.kill()
})

describe('the stdio bridge against the server', () => {
  const echo: McpTool = {
    name: 'echo',
    description: 'Echo',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    annotations: { readOnlyHint: true },
    call: async (args) => toolText(`echo: ${String(args.text)}`),
  }

  it('speaks MCP through to the tools of the chat its token names', async () => {
    const server = new SwitchboardMcpServer({ bridgeDir: () => bridgeDir })
    const launch = await server.open('chat-1', () => [echo])
    const client = connect(launch)

    const init = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe('switchboard')
    const list = await client.request('tools/list')
    expect((list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual(['echo'])
    const call = await client.request('tools/call', { name: 'echo', arguments: { text: 'hi' } })
    expect(call.result).toEqual({ content: [{ type: 'text', text: 'echo: hi' }] })
    await server.stop()
  })

  it('drops a bridge whose token it does not know', async () => {
    const server = new SwitchboardMcpServer({ bridgeDir: () => bridgeDir })
    const launch = await server.open('chat-1', () => [echo])
    const forged = join(bridgeDir, 'forged.token')
    writeFileSync(forged, 'forged')
    const client = connect({ ...launch, env: { ...launch.env, SWITCHBOARD_MCP_TOKEN_FILE: forged } })
    const answered = vi.fn()
    void client.request('initialize', {}).then(answered)
    await client.exited
    expect(answered).not.toHaveBeenCalled()
    await server.stop()
  })

  it('keeps the token off every command line: the launch names a file only this user can read', async () => {
    const server = new SwitchboardMcpServer({ bridgeDir: () => bridgeDir })
    const launch = await server.open('chat-1', () => [echo])
    const file = launch.env.SWITCHBOARD_MCP_TOKEN_FILE
    const token = readFileSync(file, 'utf8')
    expect(token.length).toBeGreaterThan(20)
    expect(JSON.stringify(launch)).not.toContain(token)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0)
    server.close('chat-1')
    expect(() => statSync(file)).toThrow()
    await server.stop()
  })

  it('cuts a live bridge off, and refuses its token, once the chat is closed', async () => {
    const server = new SwitchboardMcpServer({ bridgeDir: () => bridgeDir })
    const launch = await server.open('chat-1', () => [echo])
    const client = connect(launch)
    await client.request('initialize', {})
    server.close('chat-1')
    await client.exited

    const again = connect(launch)
    await again.exited
    expect(server.isOpen('chat-1')).toBe(false)
    await server.stop()
  })
})

// ─── Through the registry ───────────────────────────────────────

class FakeHost implements BackendHost {
  readonly events: RuntimeEvent[] = []
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn)
  }
  on(): void {}
  emit(channel: string, event: unknown): void {
    if (channel === ProviderChannels.EVENT) this.events.push(event as RuntimeEvent)
  }
  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    const fn = this.handlers.get(channel)
    if (!fn) throw new Error(`no handler registered for ${channel}`)
    return (await fn(...args)) as T
  }
}

class LaunchRecordingAdapter implements ProviderAdapter {
  readonly provider = 'codex' as const
  launches: Array<SwitchboardMcpLaunch | undefined> = []
  respondCalls = 0
  async startSession(opts: SessionStartOpts): Promise<ProviderSession> {
    this.launches.push(opts.switchboardMcp)
    return {
      threadId: opts.threadId,
      provider: 'codex',
      status: 'idle',
      runtimeMode: opts.runtimeMode ?? 'sandbox',
      cwd: opts.cwd,
      createdAt: 0,
    }
  }
  turns: string[] = []
  async sendTurn(_threadId: string, message: string): Promise<void> {
    this.turns.push(message)
  }
  async respondToRequest(): Promise<void> {
    this.respondCalls++
  }
  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async setRuntimeMode(): Promise<void> {}
  async isAvailable(): Promise<boolean> {
    return true
  }
}

describe('through the provider registry', () => {
  const PR: PrRef = { host: 'github', owner: 'acme', name: 'app', number: 612 }
  const posted: Array<{ conversationId: string; body: string }> = []
  const access: AgentPullRequestAccess = {
    linkedPrs: () => [PR],
    detail: async () => ({ ok: false, error: { kind: 'unknown', host: 'github', message: 'unused' } }),
    conversations: async () => ({
      ok: true,
      data: [
        {
          id: 'T1',
          path: 'a.ts',
          line: 3,
          side: 'new',
          resolved: false,
          outdated: false,
          comments: [
            {
              id: 'c',
              author: { login: 'rev', displayName: 'Rev', avatarUrl: null },
              body: 'Why?',
              createdAt: 0,
              url: null,
            },
          ],
        },
      ],
    }),
    reply: async (_ref, input) => {
      posted.push(input)
      return { ok: true, data: { refresh: [] } }
    },
    setResolved: async () => ({ ok: true, data: { refresh: [] } }),
    rerunCheck: async () => ({ ok: true, data: { refresh: [] } }),
  }

  it("carries a reply from the agent to a card, refuses a device without the chat scope, and posts the phone's approval as drafted", async () => {
    setAgentPullRequestAccess(access)
    const host = new FakeHost()
    const adapter = new LaunchRecordingAdapter()
    const server = new SwitchboardMcpServer({ bridgeDir: () => bridgeDir })
    const registry = new ProviderRegistry(host, new Map([['codex', adapter]]), undefined, undefined, server)
    registry.registerIpcHandlers()
    await host.invoke(ProviderChannels.START_SESSION, {
      threadId: 't1',
      provider: 'codex',
      cwd: '/tmp',
      runtimeMode: 'full-access',
    })

    const launch = adapter.launches[0]!
    expect(launch.args[0]).toBe(join(bridgeDir, 'switchboard-mcp.cjs'))
    const client = connect(launch)
    await client.request('initialize', {})
    const reply = client.request('tools/call', {
      name: 'reply_to_conversation',
      arguments: { conversationId: 'T1', text: 'Because.' },
    })
    // The call does not wait for the user: it answers that the write is queued.
    expect(((await reply).result as { content: Array<{ text: string }> }).content[0].text).toMatch(
      /^Queued for the user's approval \(card sbmcp_/,
    )

    await vi.waitFor(() => expect(host.events.some((e) => e.type === 'request.opened')).toBe(true))
    const card = host.events.find((e) => e.type === 'request.opened') as Extract<
      RuntimeEvent,
      { type: 'request.opened' }
    >
    expect(card.hostWrite).toMatchObject({
      action: 'reply',
      agentLabel: 'Codex',
      replyText: 'Because.',
      quote: { author: 'rev', body: 'Why?' },
    })
    // The card is recoverable like any other open approval.
    expect(await host.invoke(ProviderChannels.GET_PENDING_REQUESTS, 't1')).toEqual([card])

    const scopeless = withBackendRequestContext({ clientScope: 'watch', transport: 'remote', deviceScopes: [] }, () =>
      host.invoke(ProviderChannels.RESPOND_TO_REQUEST, 't1', card.requestId, 'approve', { text: 'from the watch' }),
    )
    await expect(scopeless).rejects.toThrow('cannot post')
    expect(posted).toEqual([])

    const phone = {
      clientScope: 'phone',
      transport: 'remote' as const,
      deviceScopes: ['chat' as const],
      deviceSessionId: 'dev_1',
    }
    // An app built before the digest showed a shortened card: its approval is refused.
    await expect(
      withBackendRequestContext(phone, () =>
        host.invoke(ProviderChannels.RESPOND_TO_REQUEST, 't1', card.requestId, 'approve', { resolve: false }),
      ),
    ).rejects.toThrow(HOST_WRITE_SHOWN_REQUIRED)
    expect(posted).toEqual([])

    // The phone approves the draft its card showed: replacement text from a
    // device without the admin scope is dropped before the broker sees it.
    await withBackendRequestContext(phone, () =>
      host.invoke(ProviderChannels.RESPOND_TO_REQUEST, 't1', card.requestId, 'approve', {
        resolve: false,
        text: 'Replaced on the phone',
        shown: hostWriteShownDigest(card.requestId, card.hostWrite!),
      }),
    )
    const result = await reply
    expect((result.result as { isError?: boolean }).isError).toBeUndefined()
    await vi.waitFor(() => expect(host.events.some((e) => e.type === 'approval.result')).toBe(true))
    expect(posted).toEqual([{ conversationId: 'T1', body: 'Because.\n\nvia Switchboard' }])
    expect(adapter.respondCalls).toBe(0)
    expect(host.events).toContainEqual({
      type: 'request.closed',
      threadId: 't1',
      requestId: card.requestId,
      decision: 'approve',
    })
    // The agent hears the result in a later turn of its own.
    expect(adapter.turns.at(-1)).toContain('Posted the reply')

    await host.invoke(ProviderChannels.STOP_SESSION, 't1')
    await client.exited
    expect(server.isOpen('t1')).toBe(false)
    await server.stop()
    setAgentPullRequestAccess(null)
  })

  it("posts the desktop's edit of the draft", async () => {
    setAgentPullRequestAccess(access)
    posted.length = 0
    const host = new FakeHost()
    const adapter = new LaunchRecordingAdapter()
    const server = new SwitchboardMcpServer({ bridgeDir: () => bridgeDir })
    const registry = new ProviderRegistry(host, new Map([['codex', adapter]]), undefined, undefined, server)
    registry.registerIpcHandlers()
    await host.invoke(ProviderChannels.START_SESSION, {
      threadId: 't3',
      provider: 'codex',
      cwd: '/tmp',
      runtimeMode: 'full-access',
    })
    const client = connect(adapter.launches[0]!)
    await client.request('initialize', {})
    const reply = client.request('tools/call', {
      name: 'reply_to_conversation',
      arguments: { conversationId: 'T1', text: 'Because.' },
    })
    await vi.waitFor(() => expect(host.events.some((e) => e.type === 'request.opened')).toBe(true))
    const card = host.events.find((e) => e.type === 'request.opened') as Extract<
      RuntimeEvent,
      { type: 'request.opened' }
    >

    await host.invoke(ProviderChannels.RESPOND_TO_REQUEST, 't3', card.requestId, 'approve', {
      resolve: false,
      text: 'Edited on the desktop.',
    })
    await reply
    expect(posted).toEqual([{ conversationId: 'T1', body: 'Edited on the desktop.\n\nvia Switchboard' }])

    await host.invoke(ProviderChannels.STOP_SESSION, 't3')
    await client.exited
    await server.stop()
    setAgentPullRequestAccess(null)
  })

  it('closes an open card when the user stops the session, so it never posts', async () => {
    setAgentPullRequestAccess(access)
    posted.length = 0
    const host = new FakeHost()
    const adapter = new LaunchRecordingAdapter()
    const server = new SwitchboardMcpServer({ bridgeDir: () => bridgeDir })
    const registry = new ProviderRegistry(host, new Map([['codex', adapter]]), undefined, undefined, server)
    registry.registerIpcHandlers()
    await host.invoke(ProviderChannels.START_SESSION, { threadId: 't2', provider: 'codex', cwd: '/tmp' })
    const client = connect(adapter.launches[0]!)
    await client.request('initialize', {})
    void client.request('tools/call', { name: 'reply_to_conversation', arguments: { conversationId: 'T1', text: 'x' } })
    await vi.waitFor(() => expect(host.events.some((e) => e.type === 'request.opened')).toBe(true))
    const card = host.events.find((e) => e.type === 'request.opened') as Extract<
      RuntimeEvent,
      { type: 'request.opened' }
    >

    await host.invoke(ProviderChannels.STOP_SESSION, 't2')
    expect(host.events).toContainEqual({
      type: 'request.closed',
      threadId: 't2',
      requestId: card.requestId,
      decision: 'deny',
    })
    await expect(
      host.invoke(ProviderChannels.RESPOND_TO_REQUEST, 't2', card.requestId, 'approve', {}),
    ).rejects.toThrow()
    expect(posted).toEqual([])
    await server.stop()
    setAgentPullRequestAccess(null)
  })
})
