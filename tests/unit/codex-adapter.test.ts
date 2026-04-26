import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const writes: string[] = []
let emitFailedTurn = false

type MockChild = EventEmitter & {
  stdout: PassThrough
  stderr: EventEmitter
  stdin: { writable: boolean; write: (chunk: string) => void }
  kill: ReturnType<typeof vi.fn>
}

function makeChild(): MockChild {
  const stdout = new PassThrough()
  const child = new EventEmitter() as MockChild
  child.stdout = stdout
  child.stderr = new EventEmitter()
  child.stdin = {
    writable: true,
    write: vi.fn((chunk: string) => {
      writes.push(chunk)
      const message = JSON.parse(chunk)
      if (message.method === 'initialize') {
        queueMicrotask(() => {
          stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              userAgent: 'mock-codex-app-server',
              codexHome: '/tmp/codex-home',
              platformFamily: 'unix',
              platformOs: 'macos',
            },
          }) + '\n')
        })
      }
      if (message.method === 'thread/start') {
        queueMicrotask(() => {
          stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              thread: { id: 'codex-thread-1' },
              cwd: '/tmp/project',
              model: 'gpt-5.4',
            },
          }) + '\n')
        })
      }
      if (message.method === 'turn/start') {
        queueMicrotask(() => {
          if (emitFailedTurn) {
            stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              method: 'turn/completed',
              params: {
                threadId: 'codex-thread-1',
                turn: {
                  id: 'turn-1',
                  items: [],
                  status: 'failed',
                  error: { message: 'Mock Codex failure' },
                },
              },
            }) + '\n')
            stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                turn: { id: 'turn-1', status: 'failed' },
              },
            }) + '\n')
            return
          }
          stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'item/agentMessage/delta',
            params: {
              delta: 'Hello',
              itemId: 'item-1',
              threadId: 'codex-thread-1',
              turnId: 'turn-1',
            },
          }) + '\n')
          stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'item/agentMessage/delta',
            params: {
              delta: ' from Codex',
              itemId: 'item-1',
              threadId: 'codex-thread-1',
              turnId: 'turn-1',
            },
          }) + '\n')
          stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              turn: { id: 'turn-1', status: 'running' },
            },
          }) + '\n')
        })
      }
    }),
  }
  child.kill = vi.fn()
  return child
}

vi.mock('child_process', () => ({
  execSync: vi.fn((command: string) => {
    if (command.startsWith('test -x')) return ''
    return '/usr/local/bin/codex\n'
  }),
  spawn: vi.fn(() => makeChild()),
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/switchboard-vitest'),
  },
}))

describe('CodexAdapter', () => {
  beforeEach(() => {
    writes.length = 0
    emitFailedTurn = false
    vi.clearAllMocks()
  })

  it('initializes codex app-server with client metadata and sends initialized notification', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()

    await adapter.startSession({
      threadId: 'thread-1',
      provider: 'codex',
      cwd: '/tmp/project',
    }, vi.fn())

    const messages = writes.map((line) => JSON.parse(line))

    expect(messages[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'switchboard',
          title: 'Switchboard',
          version: expect.any(String),
        },
        capabilities: {
          experimentalApi: true,
        },
      },
    })
    expect(messages[1]).toEqual({
      jsonrpc: '2.0',
      method: 'initialized',
    })
  })

  it('starts a codex thread before sending the first turn with v2 input', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()

    await adapter.startSession({
      threadId: 'thread-1',
      provider: 'codex',
      cwd: '/tmp/project',
      model: 'gpt-5.4',
      runtimeMode: 'accept-edits',
      reasoningEffort: 'high',
    }, vi.fn())

    await adapter.sendTurn('thread-1', 'hello codex')

    const messages = writes.map((line) => JSON.parse(line))
    const threadStart = messages.find((message) => message.method === 'thread/start')
    const turnStart = messages.find((message) => message.method === 'turn/start')

    expect(threadStart).toMatchObject({
      method: 'thread/start',
      params: {
        cwd: '/tmp/project',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        model: 'gpt-5.4',
      },
    })
    expect(threadStart.params).not.toHaveProperty('input')
    expect(threadStart.params).not.toHaveProperty('message')

    expect(turnStart).toMatchObject({
      method: 'turn/start',
      params: {
        threadId: 'codex-thread-1',
        input: [{ type: 'text', text: 'hello codex' }],
        approvalPolicy: 'on-request',
        sandboxPolicy: { type: 'workspaceWrite' },
        model: 'gpt-5.4',
        effort: 'high',
      },
    })
    expect(turnStart.params).not.toHaveProperty('message')
    expect(turnStart.params).not.toHaveProperty('reasoningEffort')
  })

  it('emits assistant content from codex agentMessage delta notifications', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()
    const onEvent = vi.fn()

    await adapter.startSession({
      threadId: 'thread-1',
      provider: 'codex',
      cwd: '/tmp/project',
    }, onEvent)

    await adapter.sendTurn('thread-1', 'hello codex')

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'content',
      threadId: 'thread-1',
      text: 'Hello from Codex',
      streamKind: 'assistant',
    }))
  })

  it('surfaces failed codex turns as errors instead of idle completions', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()
    const onEvent = vi.fn()
    emitFailedTurn = true

    await adapter.startSession({
      threadId: 'thread-1',
      provider: 'codex',
      cwd: '/tmp/project',
    }, onEvent)

    await adapter.sendTurn('thread-1', 'hello codex')

    expect(onEvent).toHaveBeenCalledWith({
      type: 'error',
      threadId: 'thread-1',
      message: 'Mock Codex failure',
    })
    expect(onEvent).toHaveBeenCalledWith({
      type: 'status',
      threadId: 'thread-1',
      status: 'error',
    })
  })
})
