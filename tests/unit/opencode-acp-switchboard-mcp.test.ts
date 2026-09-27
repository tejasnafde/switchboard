import { SWITCHBOARD_OPENCODE_TOOLS } from '../../src/main/mcp/agent-registration'
/**
 * OpenCode and the Switchboard MCP server: the server rides `session/new`'s
 * `mcpServers`, and a permission request for one of its tools (only sent when
 * the user's own opencode.json asks for it) is allowed without a card, since
 * the server opens its own.
 */
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'

const osMock = vi.hoisted(() => ({ homedir: '' }))
const newSessionCalls: Array<Record<string, unknown>> = []
const spawnedEnvs: Array<Record<string, string | undefined>> = []
const scratchDirs: string[] = []
let client: { requestPermission(p: RequestPermissionRequest): Promise<unknown> } | null = null

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => osMock.homedir }
})

vi.mock('child_process', () => ({
  spawn: vi.fn((_bin: unknown, _args: unknown, opts: { env: Record<string, string | undefined> }) => {
    spawnedEnvs.push(opts.env)
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

async function start(
  withServer: boolean,
  onEvent = vi.fn(),
  runtimeMode: 'plan' | 'sandbox' | 'full-access' = 'sandbox',
  resolvedEnv: Record<string, string> = {},
  cwd = '/tmp/project',
) {
  const { OpencodeAcpAdapter } = await import('../../src/main/provider/adapters/opencode-acp-adapter')
  const adapter = new OpencodeAcpAdapter()
  await adapter.startSession({
    threadId: 't1',
    provider: 'opencode',
    cwd,
    runtimeMode,
    resolvedEnv,
    ...(withServer ? { switchboardMcp: launch } : {}),
  }, onEvent)
  return { adapter, onEvent }
}

beforeEach(() => {
  newSessionCalls.length = 0
  spawnedEnvs.length = 0
  osMock.homedir = join(tmpdir(), 'sb-e2e-ocperm-missing-home')
  client = null
})

afterEach(async () => {
  for (const dir of scratchDirs.splice(0)) {
    if (dir.startsWith('/tmp/sb-e2e-ocperm.')) {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }
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

  it('injects MCP permission rules into the spawned OpenCode environment', async () => {
    await start(true, vi.fn(), 'accept-edits', {
      OPENCODE_CONFIG_CONTENT: '{"permission":{"bash":"deny"},"mcp":{"github":{"type":"local","command":["node","server.mjs"]}}}',
    })
    expect(JSON.parse(spawnedEnvs[0].OPENCODE_CONFIG_CONTENT!)).toEqual({
      permission: {
        ...Object.fromEntries(SWITCHBOARD_OPENCODE_TOOLS.map((t) => [t, 'allow'])),
        bash: 'deny',
        'github_*': 'ask',
      },
      mcp: {
        github: {
          type: 'local',
          command: ['node', 'server.mjs'],
        },
      },
    })
  })

  it('keeps a scalar user deny as the effective MCP permission', async () => {
    await start(true, vi.fn(), 'sandbox', {
      OPENCODE_CONFIG_CONTENT: '{"permission":"deny","mcp":{"github":{"type":"local","command":["node","server.mjs"]}}}',
    })
    const permission = JSON.parse(spawnedEnvs[0].OPENCODE_CONFIG_CONTENT!).permission
    expect(permission).toBe('deny')
  })

  it('does not emit a generated ask over an inline tool deny', async () => {
    await start(false, vi.fn(), 'sandbox', {
      OPENCODE_CONFIG_CONTENT: '{"permission":{"github_delete":"deny"},"mcp":{"github":{"type":"local","command":["node","server.mjs"]}}}',
    })
    const permission = JSON.parse(spawnedEnvs[0].OPENCODE_CONFIG_CONTENT!).permission
    expect(permission).toEqual({
      github_delete: 'deny',
    })
  })

  it('does not overwrite existing user permission keys', async () => {
    await start(true, vi.fn(), 'sandbox', {
      OPENCODE_CONFIG_CONTENT: '{"permission":{"github_*":"deny","switchboard_*":"deny"},"mcp":{"github":{"type":"local","command":["node","server.mjs"]}}}',
    })
    const permission = JSON.parse(spawnedEnvs[0].OPENCODE_CONFIG_CONTENT!).permission
    expect(permission).toEqual({
      'github_*': 'deny',
      'switchboard_*': 'deny',
    })
  })

  it('uses homedir as the global OpenCode config fallback when HOME is absent', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'sb-e2e-ocperm.'))
    scratchDirs.push(dir)
    osMock.homedir = dir
    await fs.mkdir(join(dir, '.config', 'opencode'), { recursive: true })
    await fs.writeFile(
      join(dir, '.config', 'opencode', 'opencode.json'),
      '{"mcp":{"github":{"type":"local","command":["node","server.mjs"]}}}',
    )

    await start(false)

    expect(JSON.parse(spawnedEnvs[0].OPENCODE_CONFIG_CONTENT!).permission).toEqual({
      'github_*': 'ask',
    })
  })

  it('does not emit a generated ask over a file-backed tool deny', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'sb-e2e-ocperm.'))
    scratchDirs.push(dir)
    await fs.writeFile(
      join(dir, 'opencode.json'),
      '{"permission":{"github_delete":"deny"},"mcp":{"github":{"type":"local","command":["node","server.mjs"]}}}',
    )

    await start(false, vi.fn(), 'sandbox', {}, dir)

    expect(spawnedEnvs[0].OPENCODE_CONFIG_CONTENT).toBeUndefined()
  })

  it('does not emit generated rules over a file-backed scalar deny', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'sb-e2e-ocperm.'))
    scratchDirs.push(dir)
    await fs.writeFile(
      join(dir, 'opencode.jsonc'),
      '{"permission":"deny","mcp":{"github":{"type":"local","command":["node","server.mjs"]}}}',
    )

    await start(true, vi.fn(), 'sandbox', {}, dir)

    expect(spawnedEnvs[0].OPENCODE_CONFIG_CONTENT).toBeUndefined()
  })

  it('does not emit generated allows when a user switchboard_* ask could match them', async () => {
    await start(true, vi.fn(), 'sandbox', {
      OPENCODE_CONFIG_CONTENT: '{"permission":{"switchboard_*":"ask"}}',
    })
    const permission = JSON.parse(spawnedEnvs[0].OPENCODE_CONFIG_CONTENT!).permission
    expect(permission).toEqual({ 'switchboard_*': 'ask' })
    for (const tool of SWITCHBOARD_OPENCODE_TOOLS) expect(permission[tool]).toBeUndefined()
  })

  it('does not emit generated rules when a user config file cannot be parsed', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'sb-e2e-ocperm.'))
    scratchDirs.push(dir)
    await fs.writeFile(join(dir, 'opencode.json'), '{"mcp":')

    await start(true, vi.fn(), 'sandbox', {}, dir)

    expect(spawnedEnvs[0].OPENCODE_CONFIG_CONTENT).toBeUndefined()
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
    const opened = onEvent.mock.calls.map(([e]) => e).find((e) => e.type === 'request.opened')
    expect(opened).toMatchObject({
      type: 'request.opened',
      requestType: 'tool',
      toolName: 'github · create_issue',
    })
  })

  it('names the matched MCP server when it contains underscores', async () => {
    const { onEvent } = await start(true, vi.fn(), 'sandbox', {
      OPENCODE_CONFIG_CONTENT: '{"mcp":{"my_server":{"type":"local","command":["node","server.mjs"]}}}',
    })
    void client!.requestPermission(permission('my_server_create_issue'))
    await new Promise((resolve) => setImmediate(resolve))
    const opened = onEvent.mock.calls.map(([e]) => e).find((e) => e.type === 'request.opened')
    expect(opened).toMatchObject({
      type: 'request.opened',
      requestType: 'tool',
      toolName: 'my_server · create_issue',
    })
  })

  it('does not trust the prefix when our server was not registered', async () => {
    const { onEvent } = await start(false)
    void client!.requestPermission(permission('switchboard_reply_to_conversation'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(onEvent.mock.calls.map(([e]) => e.type)).toContain('request.opened')
  })

  it('asks when a user server name can produce the same OpenCode tool name as one of ours', async () => {
    const { onEvent } = await start(true, vi.fn(), 'sandbox', {
      OPENCODE_CONFIG_CONTENT: '{"mcp":{"switchboard_reply":{"type":"local","command":["node","server.mjs"]}}}',
    })
    void client!.requestPermission(permission('switchboard_reply_to_conversation'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(onEvent.mock.calls.map(([e]) => e.type)).toContain('request.opened')
  })

  it('in plan mode, allows our read tools but denies our write tools', async () => {
    await start(true, vi.fn(), 'plan')
    const read = await client!.requestPermission(permission('switchboard_get_pr_status'))
    expect(read).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    const write = await client!.requestPermission(permission('switchboard_reply_to_conversation'))
    expect(write).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } })
  })

  it('denies an MCP tool in plan mode', async () => {
    const { onEvent } = await start(true, vi.fn(), 'plan')
    const answer = await client!.requestPermission(permission('github_create_issue'))
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } })
    expect(onEvent.mock.calls.map(([e]) => e)).toContainEqual(expect.objectContaining({
      type: 'tool.denied',
      toolName: 'github_create_issue',
      mode: 'plan',
    }))
  })

  it('allows an MCP tool in full access', async () => {
    const { onEvent } = await start(true, vi.fn(), 'full-access')
    const answer = await client!.requestPermission(permission('github_create_issue'))
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    expect(onEvent.mock.calls.map(([e]) => e.type)).not.toContain('request.opened')
  })
})
