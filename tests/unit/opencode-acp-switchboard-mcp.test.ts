/**
 * OpenCode and the Switchboard MCP server: the server rides `session/new`'s
 * `mcpServers`, and a permission request for one of its tools (only sent when
 * the user's own opencode.json asks for it) is allowed without a card, since
 * the server opens its own.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'

const newSessionCalls: Array<Record<string, unknown>> = []
let client: { requestPermission(p: RequestPermissionRequest): Promise<unknown> } | null = null

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new EventEmitter()
    child.pid = 4242
    child.kill = vi.fn()
    return child
  }),
}))

vi.mock('../../src/main/provider/adapters/opencode/env', () => ({
  findOpencodePath: () => '/usr/local/bin/opencode',
  buildOpencodeEnv: (overlay: Record<string, string>) => ({ ...overlay }),
}))

vi.mock('@agentclientprotocol/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentclientprotocol/sdk')>()
  class FakeConnection {
    constructor(makeClient: () => typeof client) {
      client = makeClient()
    }
    async initialize() {
      return { protocolVersion: 1, agentInfo: { name: 'opencode', version: 'test' } }
    }
    async newSession(params: Record<string, unknown>) {
      newSessionCalls.push(params)
      return { sessionId: 'acp-1' }
    }
    async setSessionMode() {
      return {}
    }
  }
  return { ...actual, ClientSideConnection: FakeConnection, ndJsonStream: () => ({}) }
})

const launch = {
  command: '/usr/local/bin/node',
  args: ['/data/mcp/switchboard-mcp.cjs'],
  env: { ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_MCP_PORT: '5000', SWITCHBOARD_MCP_TOKEN: 'tok' },
}

function permission(title: string): RequestPermissionRequest {
  return {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 'call-1', title, kind: 'other', status: 'pending', rawInput: {} },
    options: [
      { kind: 'allow_once', name: 'Allow once', optionId: 'once' },
      { kind: 'allow_always', name: 'Always allow', optionId: 'always' },
      { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
    ],
  } as RequestPermissionRequest
}

async function start(withServer: boolean, onEvent = vi.fn()) {
  const { OpencodeAcpAdapter } = await import('../../src/main/provider/adapters/opencode-acp-adapter')
  const adapter = new OpencodeAcpAdapter()
  await adapter.startSession({
    threadId: 't1',
    provider: 'opencode',
    cwd: '/tmp/project',
    runtimeMode: 'sandbox',
    ...(withServer ? { switchboardMcp: launch } : {}),
  }, onEvent)
  return { adapter, onEvent }
}

beforeEach(() => {
  newSessionCalls.length = 0
  client = null
})

describe('OpenCode registration', () => {
  it('passes the server to session/new', async () => {
    await start(true)
    expect(newSessionCalls[0].mcpServers).toEqual([{
      name: 'switchboard',
      command: launch.command,
      args: launch.args,
      env: [
        { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
        { name: 'SWITCHBOARD_MCP_PORT', value: '5000' },
        { name: 'SWITCHBOARD_MCP_TOKEN', value: 'tok' },
      ],
    }])
  })

  it('passes none when the backend opened none', async () => {
    await start(false)
    expect(newSessionCalls[0].mcpServers).toEqual([])
  })
})

describe('OpenCode permission requests', () => {
  it('allows one of our tools without a card', async () => {
    const { onEvent } = await start(true)
    const answer = await client!.requestPermission(permission('switchboard_reply_to_conversation'))
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    expect(onEvent.mock.calls.map(([e]) => e.type)).not.toContain('request.opened')
  })

  it('still asks for another server\'s tool', async () => {
    const { onEvent } = await start(true)
    void client!.requestPermission(permission('github_create_issue'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(onEvent.mock.calls.map(([e]) => e.type)).toContain('request.opened')
  })

  it('does not trust the prefix when our server was not registered', async () => {
    const { onEvent } = await start(false)
    void client!.requestPermission(permission('switchboard_reply_to_conversation'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(onEvent.mock.calls.map(([e]) => e.type)).toContain('request.opened')
  })
})
