/**
 * The generic ACP adapter against a fake agent that speaks the real protocol:
 * the SDK's AgentSideConnection on the far end of in-memory stdio, so every
 * request and notification crosses the same ndjson framing a real CLI uses.
 * No agent CLI is run.
 */
import { EventEmitter } from 'node:events'
import { PassThrough, Readable, Writable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentSideConnection,
  ndJsonStream,
  RequestError,
  type Agent,
  type NewSessionResponse,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk'
import type { RuntimeEvent } from '../../src/main/provider/types'

interface FakeAgentState {
  spawns: Array<{ bin: string; args: string[] }>
  calls: string[]
  newSession: Omit<NewSessionResponse, 'sessionId'>
  authRequired: boolean
  permission: RequestPermissionResponse | null
  mcpServers: unknown[]
  agentConnection: AgentSideConnection | null
}

const fake = vi.hoisted(() => ({ state: null as FakeAgentState | null }))

vi.mock('../../src/main/provider/adapters/acp/agent-env', () => ({
  findAgentBinary: (name: string) => `/fake/bin/${name}`,
  buildAgentEnv: (overlay: Record<string, string>) => ({ ...overlay }),
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: vi.fn((bin: string, args: string[]) => {
      const state = fake.state!
      state.spawns.push({ bin, args })
      const toAgent = new PassThrough()
      const toClient = new PassThrough()
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>
      child.stdin = toAgent
      child.stdout = toClient
      child.stderr = new EventEmitter()
      child.pid = 4242
      child.kill = vi.fn()
      const stream = ndJsonStream(
        Writable.toWeb(toClient) as WritableStream<Uint8Array>,
        Readable.toWeb(toAgent) as ReadableStream<Uint8Array>,
      )
      state.agentConnection = new AgentSideConnection((conn) => fakeAgent(conn, state), stream)
      return child
    }),
  }
})

function fakeAgent(conn: AgentSideConnection, state: FakeAgentState): Agent {
  return {
    async initialize() {
      state.calls.push('initialize')
      return { protocolVersion: 1, agentCapabilities: {} }
    },
    async authenticate() {
      return {}
    },
    async newSession(params) {
      state.calls.push('newSession')
      state.mcpServers = params.mcpServers
      if (state.authRequired) throw RequestError.authRequired()
      return { sessionId: 'sess-1', ...state.newSession }
    },
    async setSessionMode(params) {
      state.calls.push(`mode:${params.modeId}`)
      return {}
    },
    async setSessionConfigOption(params) {
      state.calls.push(`config:${params.configId}=${String(params.value)}`)
      return { configOptions: [] }
    },
    async prompt(params) {
      state.calls.push('prompt')
      await conn.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'hello' } },
      })
      await conn.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review' }] },
      })
      const answer = await conn.requestPermission({
        sessionId: params.sessionId,
        toolCall: { toolCallId: 't1', title: 'write_file', kind: 'edit' },
        options: [
          { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
      })
      state.permission = answer
      return { stopReason: 'end_turn' }
    },
    async cancel() {
      state.calls.push('cancel')
    },
  }
}

async function startGemini(events: RuntimeEvent[], extra: Record<string, unknown> = {}) {
  const { AcpAdapter } = await import('../../src/main/provider/adapters/acp/acp-adapter')
  const { genericAcpLaunchConfig } = await import('../../src/main/provider/adapters/acp/agents')
  const adapter = new AcpAdapter(genericAcpLaunchConfig('gemini'))
  await adapter.startSession({
    threadId: 'chat-1',
    provider: 'gemini',
    cwd: '/tmp/project',
    runtimeMode: 'sandbox',
    ...extra,
  }, (event) => events.push(event))
  return adapter
}

beforeEach(() => {
  fake.state = {
    spawns: [],
    calls: [],
    newSession: {
      modes: {
        currentModeId: 'default',
        availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }, { id: 'yolo', name: 'YOLO' }],
      },
      configOptions: [{
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'gemini-pro',
        options: [{ value: 'gemini-pro', name: 'Gemini Pro' }, { value: 'gemini-flash', name: 'Gemini Flash' }],
      }],
    },
    authRequired: false,
    permission: null,
    mcpServers: [],
    agentConnection: null,
  }
})

describe('generic ACP adapter over the protocol', () => {
  it('starts the agent with its launch command and reads its modes and models', async () => {
    const events: RuntimeEvent[] = []
    const adapter = await startGemini(events)
    expect(fake.state!.spawns).toEqual([{ bin: '/fake/bin/gemini', args: ['--acp'] }])
    expect(fake.state!.calls).toEqual(['initialize', 'newSession'])
    expect(events).toContainEqual({ type: 'session', threadId: 'chat-1', sessionId: 'sess-1' })
    expect(events).toContainEqual({ type: 'status', threadId: 'chat-1', status: 'idle' })
    await expect(adapter.listModels('chat-1')).resolves.toEqual([
      expect.objectContaining({ id: 'gemini-pro', label: 'Gemini Pro' }),
      expect.objectContaining({ id: 'gemini-flash', label: 'Gemini Flash' }),
    ])
  })

  it('maps plan onto the advertised plan mode and back to the mode it started in', async () => {
    const adapter = await startGemini([])
    await adapter.setRuntimeMode('chat-1', 'plan')
    await adapter.setRuntimeMode('chat-1', 'full-access')
    // Already in the starting mode: nothing to send.
    await adapter.setRuntimeMode('chat-1', 'sandbox')
    expect(fake.state!.calls.slice(2)).toEqual(['mode:plan', 'mode:default'])
  })

  it('starts in plan when the chat is in plan mode', async () => {
    await startGemini([], { runtimeMode: 'plan' })
    expect(fake.state!.calls).toEqual(['initialize', 'newSession', 'mode:plan'])
  })

  it('leaves the mode alone when the agent advertises no plan mode', async () => {
    fake.state!.newSession = { modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] } }
    const adapter = await startGemini([])
    await adapter.setRuntimeMode('chat-1', 'plan')
    expect(fake.state!.calls).toEqual(['initialize', 'newSession'])
  })

  it('sets the model through its config option', async () => {
    const adapter = await startGemini([])
    await adapter.setModel('chat-1', 'gemini-flash')
    expect(fake.state!.calls).toContain('config:model=gemini-flash')
  })

  it('streams a turn, asks for an edit in sandbox mode, and passes the answer back', async () => {
    const events: RuntimeEvent[] = []
    const adapter = await startGemini(events)
    await adapter.sendTurn('chat-1', 'hi')
    await vi.waitFor(() => expect(events.some((e) => e.type === 'request.opened')).toBe(true))
    const opened = events.find((e) => e.type === 'request.opened') as Extract<RuntimeEvent, { type: 'request.opened' }>
    expect(opened.toolName).toBe('write_file')
    await adapter.respondToRequest('chat-1', opened.requestId, 'approve')
    await vi.waitFor(() => expect(events.some((e) => e.type === 'turn.completed')).toBe(true))
    expect(fake.state!.permission).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } })
    expect(events).toContainEqual(expect.objectContaining({ type: 'content', text: 'hello', streamKind: 'assistant' }))
    await expect(adapter.listSkills('chat-1')).resolves.toEqual([{ name: 'review', description: 'Review', source: 'gemini' }])
  })

  it('denies an edit in plan mode without asking', async () => {
    const events: RuntimeEvent[] = []
    const adapter = await startGemini(events, { runtimeMode: 'plan' })
    await adapter.sendTurn('chat-1', 'hi')
    await vi.waitFor(() => expect(events.some((e) => e.type === 'turn.completed')).toBe(true))
    expect(fake.state!.permission).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } })
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.denied', toolName: 'write_file', mode: 'plan' }))
    expect(events.some((e) => e.type === 'request.opened')).toBe(false)
  })

  it('refuses a second plain send while a prompt runs, naming the agent', async () => {
    const adapter = await startGemini([])
    await adapter.sendTurn('chat-1', 'first')
    await expect(adapter.sendTurn('chat-1', 'second')).rejects.toThrow('Gemini CLI is mid-turn')
  })

  it('registers the Switchboard MCP server on session/new', async () => {
    await startGemini([], { switchboardMcp: { command: '/node', args: ['bridge.cjs'], env: { SWITCHBOARD_MCP_TOKEN_FILE: '/t' } } })
    expect(fake.state!.mcpServers).toEqual([{ name: 'switchboard', command: '/node', args: ['bridge.cjs'], env: [{ name: 'SWITCHBOARD_MCP_TOKEN_FILE', value: '/t' }] }])
  })

  it('names the sign-in step when the agent answers authentication required', async () => {
    fake.state!.authRequired = true
    const events: RuntimeEvent[] = []
    await expect(startGemini(events)).rejects.toThrow(/Gemini CLI ACP init failed: .*Authentication required.*Run `gemini` in a terminal once and sign in/)
    expect(events).toContainEqual({ type: 'status', threadId: 'chat-1', status: 'error' })
  })
})
