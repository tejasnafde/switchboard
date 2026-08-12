import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// These tests spawn a (mocked) codex app-server and await the JSON-RPC
// handshake. On CPU-starved parallel CI runners (Windows) that in-process
// round-trip can exceed vitest's 5s default and trip a spurious timeout - the
// adapter's own 30s INIT_TIMEOUT_MS is the real hang guard, so give the file
// headroom.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

const writes: string[] = []
let emitFailedTurn = false
let turnStartErrors: string[] = []
let turnRetryMessages: string[] = []
let fileChanges: Array<{ path: string; kind: { type: string; move_path?: string | null }; diff: string }> = []
let fileChangePatchUpdates: typeof fileChanges[] = []
let fileChangeStatus = 'completed'
let omitFileChangesAtStart = false
let stallInitialize = false
let initStderrChunks: string[] = []
let lastChild: MockChild | null = null

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
        if (stallInitialize) {
          // Simulate a codex that never responds (wrong binary, stuck on
          // auth, etc.). The adapter's withTimeout should fire instead.
          for (const chunk of initStderrChunks) {
            queueMicrotask(() => child.stderr.emit('data', Buffer.from(chunk)))
          }
          return
        }
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
      if (message.method === 'thread/resume') {
        queueMicrotask(() => {
          stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              thread: { id: message.params.threadId },
              cwd: '/tmp/project',
              model: 'gpt-5.4',
            },
          }) + '\n')
        })
      }
      if (message.method === 'model/list') {
        queueMicrotask(() => {
          stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              data: [
                { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', hidden: false, isDefault: true },
                { id: 'gpt-5-mini', displayName: 'GPT-5 mini', hidden: false, isDefault: false },
              ],
              nextCursor: null,
            },
          }) + '\n')
        })
      }
      if (message.method === 'skills/list') {
        queueMicrotask(() => {
          stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              data: [{
                cwd: '/tmp/project',
                errors: [],
                skills: [{
                  name: 'review',
                  description: 'Review changes',
                  path: '/tmp/skills/review/SKILL.md',
                  enabled: true,
                }],
              }],
            },
          }) + '\n')
        })
      }
      if (message.method === 'turn/start') {
        queueMicrotask(() => {
          const turnStartError = turnStartErrors.shift()
          if (turnStartError) {
            stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32600, message: turnStartError },
            }) + '\n')
            return
          }
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
            method: 'turn/started',
            params: {
              threadId: 'codex-thread-1',
              turn: { id: 'turn-1', status: 'inProgress' },
            },
          }) + '\n')
          for (const retryMessage of turnRetryMessages) {
            stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              method: 'error',
              params: {
                error: { message: retryMessage },
                willRetry: true,
                threadId: 'codex-thread-1',
                turnId: 'turn-1',
              },
            }) + '\n')
          }
          stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'thread/status/changed',
            params: {
              threadId: 'codex-thread-1',
              status: { type: 'active', activeFlags: [] },
            },
          }) + '\n')
          stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'thread/tokenUsage/updated',
            params: {
              threadId: 'codex-thread-1',
              turnId: 'turn-1',
              tokenUsage: {
                last: { totalTokens: 128000, inputTokens: 120000, outputTokens: 8000 },
                total: { totalTokens: 4200000, inputTokens: 4000000, outputTokens: 200000 },
                modelContextWindow: 258400,
              },
            },
          }) + '\n')
          stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'item/started',
            params: {
              threadId: 'codex-thread-1',
              turnId: 'turn-1',
              item: {
                id: 'cmd-1',
                type: 'commandExecution',
                command: 'npm test',
                commandActions: [],
                cwd: '/tmp/project',
                status: 'inProgress',
              },
            },
          }) + '\n')
          stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'item/commandExecution/outputDelta',
            params: {
              threadId: 'codex-thread-1',
              turnId: 'turn-1',
              itemId: 'cmd-1',
              delta: 'running ',
            },
          }) + '\n')
          stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'item/commandExecution/outputDelta',
            params: {
              threadId: 'codex-thread-1',
              turnId: 'turn-1',
              itemId: 'cmd-1',
              delta: 'tests\n',
            },
          }) + '\n')
          stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'item/completed',
            params: {
              threadId: 'codex-thread-1',
              turnId: 'turn-1',
              item: {
                id: 'cmd-1',
                type: 'commandExecution',
                command: 'npm test',
                commandActions: [],
                cwd: '/tmp/project',
                status: 'completed',
                exitCode: 0,
                aggregatedOutput: 'all tests passed',
              },
            },
          }) + '\n')
          if (fileChanges.length > 0) {
            stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              method: 'item/started',
              params: {
                threadId: 'codex-thread-1',
                turnId: 'turn-1',
                item: {
                  id: 'file-1',
                  type: 'fileChange',
                  changes: omitFileChangesAtStart ? [] : fileChanges,
                  status: 'inProgress',
                },
              },
            }) + '\n')
            for (const changes of fileChangePatchUpdates) {
              stdout.write(JSON.stringify({
                jsonrpc: '2.0',
                method: 'item/fileChange/patchUpdated',
                params: {
                  threadId: 'codex-thread-1',
                  turnId: 'turn-1',
                  itemId: 'file-1',
                  changes,
                },
              }) + '\n')
            }
            stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              method: 'item/completed',
              params: {
                threadId: 'codex-thread-1',
                turnId: 'turn-1',
                item: {
                  id: 'file-1',
                  type: 'fileChange',
                  changes: fileChanges,
                  status: fileChangeStatus,
                },
              },
            }) + '\n')
          }
          stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'turn/diff/updated',
            params: {
              threadId: 'codex-thread-1',
              turnId: 'turn-1',
              diff: 'diff --git a/a.txt b/a.txt\n+hello\n',
            },
          }) + '\n')
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
            method: 'item/reasoning/textDelta',
            params: {
              delta: 'Thinking ',
              itemId: 'reason-1',
              threadId: 'codex-thread-1',
              turnId: 'turn-1',
            },
          }) + '\n')
          stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'item/reasoning/textDelta',
            params: {
              delta: 'with Codex',
              itemId: 'reason-1',
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
      if (message.method === 'turn/steer') {
        queueMicrotask(() => {
          stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { turnId: 'turn-1' },
          }) + '\n')
        })
      }
      if (message.method === 'turn/interrupt') {
        queueMicrotask(() => {
          stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {},
          }) + '\n')
        })
      }
    }),
  }
  child.kill = vi.fn()
  lastChild = child
  return child
}

vi.mock('child_process', () => ({
  execSync: vi.fn((command: string) => {
    if (command.startsWith('test -x')) return ''
    return '/usr/local/bin/codex\n'
  }),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '/usr/local/bin/codex\n', stderr: '', error: undefined })),
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
    turnStartErrors = []
    turnRetryMessages = []
    fileChanges = []
    fileChangePatchUpdates = []
    fileChangeStatus = 'completed'
    omitFileChangesAtStart = false
    stallInitialize = false
    initStderrChunks = []
    lastChild = null
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

  it('parses the current cwd-grouped skills/list response including skill paths', async () => {
    const { parseCodexSkills } = await import('../../src/main/provider/adapters/codex-adapter')
    expect(parseCodexSkills({
      data: [{
        cwd: '/tmp/project',
        errors: [],
        skills: [{ name: 'review', description: 'Review changes', path: '/tmp/skills/review/SKILL.md', enabled: true }],
      }],
    })).toEqual([{
      name: 'review',
      description: 'Review changes',
      path: '/tmp/skills/review/SKILL.md',
      source: 'codex',
    }])
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

  it('loads a persisted codex thread with thread/resume before sending another turn', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()

    await adapter.startSession({
      threadId: 'switchboard-thread-1',
      provider: 'codex',
      cwd: '/tmp/project',
      resumeSessionId: 'codex-thread-existing',
    }, vi.fn())

    const messages = writes.map((line) => JSON.parse(line))
    expect(messages.find((message) => message.method === 'thread/resume')).toMatchObject({
      params: {
        threadId: 'codex-thread-existing',
        cwd: '/tmp/project',
      },
    })

    await adapter.sendTurn('switchboard-thread-1', 'resume here')

    const afterTurn = writes.map((line) => JSON.parse(line))
    expect(afterTurn.some((message) => message.method === 'thread/start')).toBe(false)
    expect(afterTurn.find((message) => message.method === 'turn/start')).toMatchObject({
      params: {
        threadId: 'codex-thread-existing',
        input: [{ type: 'text', text: 'resume here' }],
      },
    })
  })

  it('replaces a stale resumed thread and retries the turn once', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()
    turnStartErrors = ['thread not found: codex-thread-existing']

    await adapter.startSession({
      threadId: 'switchboard-thread-1',
      provider: 'codex',
      cwd: '/tmp/project',
      resumeSessionId: 'codex-thread-existing',
    }, vi.fn())

    await adapter.sendTurn('switchboard-thread-1', 'recover this turn')

    const messages = writes.map((line) => JSON.parse(line))
    const turnStarts = messages.filter((message) => message.method === 'turn/start')
    expect(turnStarts.map((message) => message.params.threadId)).toEqual([
      'codex-thread-existing',
      'codex-thread-1',
    ])
    expect(messages.filter((message) => message.method === 'thread/start')).toHaveLength(1)
  })

  it('rejects a non-recoverable turn-start failure and restores idle status', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()
    const onEvent = vi.fn()
    turnStartErrors = ['model not loaded']

    await adapter.startSession({
      threadId: 'thread-1',
      provider: 'codex',
      cwd: '/tmp/project',
    }, onEvent)

    await expect(adapter.sendTurn('thread-1', 'do not hang')).rejects.toThrow('model not loaded')
    expect(onEvent).toHaveBeenLastCalledWith({
      type: 'status',
      threadId: 'thread-1',
      status: 'idle',
    })
  })

  it('emits retry progress instead of errors while Codex reconnects a turn', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()
    const onEvent = vi.fn()
    turnRetryMessages = ['Reconnecting... 1/5', 'Reconnecting... 2/5']

    await adapter.startSession({
      threadId: 'thread-1',
      provider: 'codex',
      cwd: '/tmp/project',
    }, onEvent)

    await adapter.sendTurn('thread-1', 'keep going')

    expect(onEvent).toHaveBeenCalledWith({
      type: 'turn.retrying',
      threadId: 'thread-1',
      turnId: 'turn-1',
      message: 'Reconnecting... 2/5',
    })
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: expect.stringContaining('Reconnecting'),
    }))
  })

  it('lists the live Codex model catalog instead of relying on stale static ids', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()

    await adapter.startSession({
      threadId: 'thread-1',
      provider: 'codex',
      cwd: '/tmp/project',
    }, vi.fn())

    await expect(adapter.listModels?.('thread-1')).resolves.toEqual([
      { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', tier: 'max' },
      { id: 'gpt-5-mini', label: 'GPT-5 mini', tier: 'fast' },
    ])
    expect(writes.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({
      method: 'model/list',
      params: { limit: 100, includeHidden: false },
    }))
  })

  it('uses a model selected after session startup on the next Codex turn', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()

    await adapter.startSession({
      threadId: 'thread-1',
      provider: 'codex',
      cwd: '/tmp/project',
      model: 'gpt-5-mini',
    }, vi.fn())
    await adapter.setModel?.('thread-1', 'gpt-5.6-sol')
    await adapter.sendTurn('thread-1', 'use the new model')

    const frames = writes.map((line) => JSON.parse(line))
    expect(frames.find((message) => message.method === 'thread/start')?.params.model).toBe('gpt-5.6-sol')
    expect(frames.find((message) => message.method === 'turn/start')?.params.model).toBe('gpt-5.6-sol')
  })

  it('maps Switchboard approval decisions to Codex accept/decline values', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()
    const onEvent = vi.fn()

    await adapter.startSession({
      threadId: 'thread-1',
      provider: 'codex',
      cwd: '/tmp/project',
      runtimeMode: 'sandbox',
    }, onEvent)

    lastChild?.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 900,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'codex-thread-1', turnId: 'turn-1', itemId: 'cmd-1', command: 'npm test' },
    }) + '\n')
    await new Promise((resolve) => setImmediate(resolve))
    const opened = onEvent.mock.calls.map(([event]) => event).find((event) => event.type === 'request.opened')
    expect(opened).toBeTruthy()

    await adapter.respondToRequest('thread-1', opened.requestId, 'approve')

    expect(writes.map((line) => JSON.parse(line))).toContainEqual({
      jsonrpc: '2.0',
      id: 900,
      result: { decision: 'accept' },
    })
  })

  it('handles current item/tool/requestUserInput requests and keys answers by question id', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()
    const onEvent = vi.fn()

    await adapter.startSession({
      threadId: 'thread-1',
      provider: 'codex',
      cwd: '/tmp/project',
    }, onEvent)

    lastChild?.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 901,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'codex-thread-1',
        turnId: 'turn-1',
        itemId: 'question-tool-1',
        autoResolutionMs: null,
        questions: [{
          id: 'deploy_target',
          header: 'Target',
          question: 'Where should this deploy?',
          isOther: true,
          isSecret: false,
          options: [{ label: 'Production', description: 'Deploy to prod' }],
        }],
      },
    }) + '\n')
    await new Promise((resolve) => setImmediate(resolve))
    const asked = onEvent.mock.calls.map(([event]) => event).find((event) => event.type === 'question.asked')
    expect(asked?.questions[0]).toMatchObject({
      id: 'deploy_target',
      header: 'Target',
      question: 'Where should this deploy?',
    })

    await adapter.answerQuestion?.('thread-1', asked.requestId, [['Production']])

    expect(writes.map((line) => JSON.parse(line))).toContainEqual({
      jsonrpc: '2.0',
      id: 901,
      result: { answers: { deploy_target: { answers: ['Production'] } } },
    })
  })

  it('keeps the legacy user-input response shape for older Codex builds', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()
    const onEvent = vi.fn()

    await adapter.startSession({
      threadId: 'thread-1',
      provider: 'codex',
      cwd: '/tmp/project',
    }, onEvent)

    lastChild?.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 902,
      method: 'item/userInput/request',
      params: {
        questions: [{ header: 'Target', question: 'Where?', options: [] }],
      },
    }) + '\n')
    await new Promise((resolve) => setImmediate(resolve))
    const asked = onEvent.mock.calls.map(([event]) => event).find((event) => event.type === 'question.asked')

    await adapter.answerQuestion?.('thread-1', asked.requestId, [['Production']])

    expect(writes.map((line) => JSON.parse(line))).toContainEqual({
      jsonrpc: '2.0',
      id: 902,
      result: { answers: [['Production']] },
    })
  })

  it('sends a selected Codex skill as a typed skill input block', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()

    await adapter.startSession({
      threadId: 'thread-1',
      provider: 'codex',
      cwd: '/tmp/project',
    }, vi.fn())
    await adapter.listSkills('thread-1')
    await adapter.sendTurn('thread-1', '$review focus on auth')

    const turn = writes.map((line) => JSON.parse(line)).find((message) => message.method === 'turn/start')
    expect(turn.params.input).toEqual([
      { type: 'skill', name: 'review', path: '/tmp/skills/review/SKILL.md' },
      { type: 'text', text: 'focus on auth' },
    ])
  })

  it('emits session and status events from codex thread and turn notifications', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()
    const onEvent = vi.fn()

    await adapter.startSession({
      threadId: 'switchboard-thread-1',
      provider: 'codex',
      cwd: '/tmp/project',
    }, onEvent)

    await adapter.sendTurn('switchboard-thread-1', 'hello codex')

    expect(onEvent).toHaveBeenCalledWith({
      type: 'session',
      threadId: 'switchboard-thread-1',
      sessionId: 'codex-thread-1',
    })
    expect(onEvent).toHaveBeenCalledWith({
      type: 'status',
      threadId: 'switchboard-thread-1',
      status: 'running',
    })
  })

  it('uses Codex last token usage as current context instead of cumulative total processed tokens', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()
    const onEvent = vi.fn()

    await adapter.startSession({
      threadId: 'thread-1',
      provider: 'codex',
      cwd: '/tmp/project',
    }, onEvent)

    await adapter.sendTurn('thread-1', 'hello codex')

    expect(onEvent).toHaveBeenCalledWith({
      type: 'context_window',
      threadId: 'thread-1',
      usedTokens: 128000,
      maxTokens: 258400,
    })
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'context_window',
      usedTokens: 4200000,
    }))
  })

  it('maps Codex command lifecycle items to existing tool started and completed events', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()
    const onEvent = vi.fn()

    await adapter.startSession({
      threadId: 'thread-1',
      provider: 'codex',
      cwd: '/tmp/project',
    }, onEvent)

    await adapter.sendTurn('thread-1', 'hello codex')

    expect(onEvent).toHaveBeenCalledWith({
      type: 'tool.started',
      threadId: 'thread-1',
      toolId: 'cmd-1',
      toolName: 'Bash',
      input: {
        command: 'npm test',
        cwd: '/tmp/project',
      },
    })
    expect(onEvent).toHaveBeenCalledWith({
      type: 'tool.completed',
      threadId: 'thread-1',
      toolId: 'cmd-1',
      output: 'running tests\n',
    })
    expect(onEvent).toHaveBeenCalledWith({
      type: 'tool.completed',
      threadId: 'thread-1',
      toolId: 'cmd-1',
      output: 'all tests passed',
    })
  })

  it('does not render the aggregate turn diff as a duplicate raw Edit card', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()
    const onEvent = vi.fn()

    await adapter.startSession({
      threadId: 'thread-1',
      provider: 'codex',
      cwd: '/tmp/project',
    }, onEvent)

    await adapter.sendTurn('thread-1', 'hello codex')

    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'diff_turn-1',
    }))
  })

  it('maps every Codex fileChange hunk to a Claude-compatible Edit card', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()
    const onEvent = vi.fn()
    fileChanges = [
      {
        path: '/tmp/project/src/a.ts',
        kind: { type: 'update', move_path: null },
        diff: '@@ -1,2 +1,2 @@\n const value = 1\n-oldCall()\n+newCall()\n@@ -20 +20 @@\n---counter\n+++counter\n',
      },
      {
        path: '/tmp/project/src/b.ts',
        kind: { type: 'add' },
        diff: '@@ -0,0 +1 @@\n+export const added = true\n',
      },
    ]

    await adapter.startSession({
      threadId: 'thread-1',
      provider: 'codex',
      cwd: '/tmp/project',
    }, onEvent)
    await adapter.sendTurn('thread-1', 'edit both files')

    expect(onEvent).toHaveBeenCalledWith({
      type: 'tool.started',
      threadId: 'thread-1',
      toolId: 'file-1:0',
      toolName: 'Edit',
      input: {
        file_path: '/tmp/project/src/a.ts',
        old_string: 'const value = 1\noldCall()',
        new_string: 'const value = 1\nnewCall()',
      },
    })
    expect(onEvent).toHaveBeenCalledWith({
      type: 'tool.started',
      threadId: 'thread-1',
      toolId: 'file-1:1',
      toolName: 'Edit',
      input: {
        file_path: '/tmp/project/src/a.ts',
        old_string: '--counter',
        new_string: '++counter',
      },
    })
    expect(onEvent).toHaveBeenCalledWith({
      type: 'tool.started',
      threadId: 'thread-1',
      toolId: 'file-1:2',
      toolName: 'Edit',
      input: {
        file_path: '/tmp/project/src/b.ts',
        old_string: '',
        new_string: 'export const added = true',
      },
    })
    expect(onEvent).toHaveBeenCalledWith({
      type: 'tool.completed',
      threadId: 'thread-1',
      toolId: 'file-1:0',
      output: 'Applied',
    })
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'file-1',
      output: expect.stringContaining('changes'),
    }))
  })

  it('does not call a failed Codex file change Applied', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()
    const onEvent = vi.fn()
    fileChanges = [{
      path: '/tmp/project/src/a.ts',
      kind: { type: 'update', move_path: null },
      diff: '@@ -1 +1 @@\n-old\n+new\n',
    }]
    fileChangeStatus = 'failed'

    await adapter.startSession({ threadId: 'thread-1', provider: 'codex', cwd: '/tmp/project' }, onEvent)
    await adapter.sendTurn('thread-1', 'try the edit')

    expect(onEvent).toHaveBeenCalledWith({
      type: 'tool.completed',
      threadId: 'thread-1',
      toolId: 'file-1:0',
      output: 'Failed',
    })
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'file-1:0',
      output: 'Applied',
    }))
  })

  it('renders a Codex edit when the diff arrives only with item/completed', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()
    const onEvent = vi.fn()
    fileChanges = [{
      path: '/tmp/project/src/a.ts',
      kind: { type: 'update', move_path: null },
      diff: '@@ -1 +1 @@\n-old\n+new\n',
    }]
    omitFileChangesAtStart = true

    await adapter.startSession({ threadId: 'thread-1', provider: 'codex', cwd: '/tmp/project' }, onEvent)
    await adapter.sendTurn('thread-1', 'make the edit')

    expect(onEvent).toHaveBeenCalledWith({
      type: 'tool.started',
      threadId: 'thread-1',
      toolId: 'file-1:0',
      toolName: 'Edit',
      input: {
        file_path: '/tmp/project/src/a.ts',
        old_string: 'old',
        new_string: 'new',
      },
    })
    expect(onEvent).toHaveBeenCalledWith({
      type: 'tool.completed',
      threadId: 'thread-1',
      toolId: 'file-1:0',
      output: 'Applied',
    })
  })

  it('refreshes an Edit card when Codex expands a file patch', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()
    const onEvent = vi.fn()
    fileChanges = [{
      path: '/tmp/project/src/a.ts',
      kind: { type: 'update', move_path: null },
      diff: '@@ -1,2 +1,2 @@\n-old()\n+new()\n keep()\n',
    }]
    fileChangePatchUpdates = [[{
      path: '/tmp/project/src/a.ts',
      kind: { type: 'update', move_path: null },
      diff: '@@ -1,3 +1,3 @@\n-old()\n+new()\n keep()\n-tail()\n+replacement()\n',
    }]]

    await adapter.startSession({ threadId: 'thread-1', provider: 'codex', cwd: '/tmp/project' }, onEvent)
    await adapter.sendTurn('thread-1', 'expand the edit')

    expect(onEvent).toHaveBeenCalledWith({
      type: 'tool.started',
      threadId: 'thread-1',
      toolId: 'file-1:0',
      toolName: 'Edit',
      input: {
        file_path: '/tmp/project/src/a.ts',
        old_string: 'old()\nkeep()\ntail()',
        new_string: 'new()\nkeep()\nreplacement()',
      },
    })
  })

  it('renders a rename-only Codex file change', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()
    const onEvent = vi.fn()
    fileChanges = [{
      path: '/tmp/project/src/old.ts',
      kind: { type: 'update', move_path: '/tmp/project/src/new.ts' },
      diff: '',
    }]

    await adapter.startSession({ threadId: 'thread-1', provider: 'codex', cwd: '/tmp/project' }, onEvent)
    await adapter.sendTurn('thread-1', 'rename the file')

    expect(onEvent).toHaveBeenCalledWith({
      type: 'tool.started',
      threadId: 'thread-1',
      toolId: 'file-1:0',
      toolName: 'Edit',
      input: {
        file_path: '/tmp/project/src/old.ts',
        move_path: '/tmp/project/src/new.ts',
        old_string: '',
        new_string: '',
      },
    })
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

    // Each delta travels as itself; consumers fold with applyContentText. The
    // adapter still accumulates internally, because codex mixes delta and
    // whole-body forms for the same message id.
    const chunks = onEvent.mock.calls
      .map(([e]) => e as { type: string; streamKind?: string; text?: string; append?: boolean })
      .filter((e) => e.type === 'content' && e.streamKind === 'assistant')
    expect(chunks.map((c) => c.text)).toEqual(['Hello', ' from Codex'])
    expect(chunks.every((c) => c.append === true)).toBe(true)
  })

  it('steers a running turn with turn/steer instead of a concurrent turn/start', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()
    const onEvent = vi.fn()

    await adapter.startSession({
      threadId: 'thread-1',
      provider: 'codex',
      cwd: '/tmp/project',
    }, onEvent)

    // First turn starts turn-1; the mock never emits turn/completed, so the
    // turn stays active and the next send must steer it.
    await adapter.sendTurn('thread-1', 'hello codex')
    writes.length = 0
    await adapter.sendTurn('thread-1', 'actually, focus on the parser')

    const frames = writes.map((w) => JSON.parse(w))
    const steer = frames.find((m) => m.method === 'turn/steer')
    expect(steer).toBeTruthy()
    expect(steer.params).toMatchObject({
      threadId: 'codex-thread-1',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'actually, focus on the parser' }],
    })
    // Must not open a second concurrent turn.
    expect(frames.some((m) => m.method === 'turn/start')).toBe(false)
  })

  it('starts a fresh turn (not a steer) after an interrupt clears the active turn id', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()
    const onEvent = vi.fn()

    await adapter.startSession({
      threadId: 'thread-1',
      provider: 'codex',
      cwd: '/tmp/project',
    }, onEvent)

    await adapter.sendTurn('thread-1', 'hello codex')
    await adapter.interruptTurn('thread-1')
    writes.length = 0
    await adapter.sendTurn('thread-1', 'new direction after stopping')

    const frames = writes.map((w) => JSON.parse(w))
    // The interrupted turn is dead, so this must be a fresh turn/start, not a
    // steer against a stale expectedTurnId.
    expect(frames.some((m) => m.method === 'turn/start')).toBe(true)
    expect(frames.some((m) => m.method === 'turn/steer')).toBe(false)
  })

  it('ships reasoning deltas as increments, so a long stream stays linear on the wire', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()
    const onEvent = vi.fn()

    await adapter.startSession({
      threadId: 'thread-1',
      provider: 'codex',
      cwd: '/tmp/project',
    }, onEvent)

    await adapter.sendTurn('thread-1', 'think')

    // Each delta travels as itself. Re-sending the accumulated body every token
    // made a reply cost O(n^2) bytes, which is invisible locally and ruinous
    // over a phone's radio. Consumers fold with applyContentText.
    const chunks = onEvent.mock.calls
      .map(([e]) => e as { type: string; messageId?: string; text?: string; append?: boolean })
      .filter((e) => e.type === 'content' && e.messageId === 'reason-1')
    expect(chunks.map((c) => c.text)).toEqual(['Thinking ', 'with Codex'])
    expect(chunks.every((c) => c.append === true)).toBe(true)
  })

  it('rejects startSession when codex never responds to initialize, surfacing stderr in the error', async () => {
    vi.useFakeTimers()
    try {
      stallInitialize = true
      initStderrChunks = ['error: please run `codex login` first\n']

      const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
      const adapter = new CodexAdapter()
      const onEvent = vi.fn()

      // Attach a catch handler synchronously so the rejection is never
      // observed as unhandled - we still assert on the value below.
      const startPromise = adapter.startSession({
        threadId: 'thread-1',
        provider: 'codex',
        cwd: '/tmp/project',
      }, onEvent)
      const settled: { error: Error | null } = { error: null }
      const tracked = startPromise.catch((err: Error) => { settled.error = err })

      // Let the spawn + stderr microtasks flush, then jump past the
      // 30s init timeout window.
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(30_000)
      await tracked

      expect(settled.error).toBeInstanceOf(Error)
      expect(settled.error?.message).toMatch(/Init failed: initialize timed out/)
      // The codex stderr trail should land in the user-visible error so
      // the actual cause ("please run `codex login`") is surfaced.
      expect(settled.error?.message).toMatch(/codex login/)

      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'error',
        threadId: 'thread-1',
        message: expect.stringContaining('codex login'),
      }))
      expect(onEvent).toHaveBeenCalledWith({
        type: 'status',
        threadId: 'thread-1',
        status: 'error',
      })

      // Subsequent sendTurn must fail fast with "not found" - the
      // half-init session should have been deleted from the registry,
      // not left dangling for stopSession to reject later.
      await expect(adapter.sendTurn('thread-1', 'hi')).rejects.toThrow(/not found/)
    } finally {
      vi.useRealTimers()
    }
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
      turnId: 'turn-1',
      message: 'Mock Codex failure',
    })
    expect(onEvent).toHaveBeenCalledWith({
      type: 'status',
      threadId: 'thread-1',
      status: 'error',
    })
  })
})
