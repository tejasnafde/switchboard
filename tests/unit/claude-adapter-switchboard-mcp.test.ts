/**
 * Claude and the Switchboard MCP server: the SDK is handed the server under
 * `mcpServers`, and `canUseTool` lets its tools through, because the server
 * denies in plan mode and opens its own card. Another server's tools still
 * go through the ordinary policy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type CanUseTool = (toolName: string, input: Record<string, unknown>) => Promise<{ behavior: string; message?: string }>
let captured: { mcpServers?: Record<string, unknown>; canUseTool: CanUseTool } | null = null

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { options: typeof captured }) => {
    captured = args.options
    // A query that never yields: the test only needs its options.
    return {
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {})
      },
      interrupt: vi.fn(),
      setPermissionMode: vi.fn(),
      close: vi.fn(),
    }
  }),
}))

// No claude binary, so no auth probe runs against a real profile.
vi.mock('../../src/main/provider/managed-bin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/managed-bin')>()
  return { ...actual, createExecutableCache: () => ({ refresh: () => null, current: () => null }) }
})

const launch = {
  command: '/usr/local/bin/node',
  args: ['/data/mcp/switchboard-mcp.cjs'],
  env: { ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_MCP_PORT: '5000', SWITCHBOARD_MCP_TOKEN: 'tok' },
}

async function startTurn(mode: 'plan' | 'sandbox', withServer: boolean) {
  const { ClaudeAdapter } = await import('../../src/main/provider/adapters/claude-adapter')
  const adapter = new ClaudeAdapter()
  const onEvent = vi.fn()
  await adapter.startSession(
    {
      threadId: 't1',
      provider: 'claude',
      cwd: '/tmp',
      runtimeMode: mode,
      ...(withServer ? { switchboardMcp: launch } : {}),
    },
    onEvent,
  )
  await adapter.sendTurn('t1', 'hello', mode)
  await vi.waitFor(() => expect(captured).not.toBeNull())
  return { adapter, onEvent }
}

beforeEach(() => {
  captured = null
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('Claude registration', () => {
  it('hands the SDK the server as a stdio MCP server named switchboard', async () => {
    const { adapter } = await startTurn('sandbox', true)
    expect(captured!.mcpServers).toEqual({ switchboard: { type: 'stdio', ...launch } })
    await adapter.stopSession('t1')
  })

  it('adds no server when the backend opened none', async () => {
    const { adapter } = await startTurn('sandbox', false)
    expect(captured!.mcpServers).toBeUndefined()
    await adapter.stopSession('t1')
  })
})

describe('Claude canUseTool for the Switchboard tools', () => {
  it('allows them without a card, in sandbox', async () => {
    const { adapter, onEvent } = await startTurn('sandbox', true)
    const decision = await captured!.canUseTool('mcp__switchboard__reply_to_conversation', { text: 'done' })
    expect(decision.behavior).toBe('allow')
    expect(onEvent.mock.calls.map(([e]) => e.type)).not.toContain('request.opened')
    await adapter.stopSession('t1')
  })

  it('allows the diff, line comment and review tools without a card', async () => {
    const { adapter, onEvent } = await startTurn('sandbox', true)
    for (const tool of ['get_pr_diff', 'comment_on_line', 'draft_review']) {
      expect((await captured!.canUseTool(`mcp__switchboard__${tool}`, {})).behavior).toBe('allow')
    }
    expect(onEvent.mock.calls.map(([e]) => e.type)).not.toContain('request.opened')
    await adapter.stopSession('t1')
  })

  it('allows them in plan mode too, where the server does the refusing', async () => {
    const { adapter } = await startTurn('plan', true)
    expect((await captured!.canUseTool('mcp__switchboard__send_agent_message', {})).behavior).toBe('allow')
    await adapter.stopSession('t1')
  })

  it("still denies another server's tool in plan mode", async () => {
    const { adapter } = await startTurn('plan', true)
    expect((await captured!.canUseTool('mcp__slack__post_message', {})).behavior).toBe('deny')
    await adapter.stopSession('t1')
  })

  it('does not trust the prefix when the server was not registered', async () => {
    const { adapter } = await startTurn('plan', false)
    expect((await captured!.canUseTool('mcp__switchboard__reply_to_conversation', {})).behavior).toBe('deny')
    await adapter.stopSession('t1')
  })
})
