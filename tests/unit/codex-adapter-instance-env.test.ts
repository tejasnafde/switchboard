/**
 * codex-adapter spawns `codex app-server` with the resolved provider-instance
 * env merged in, and CODEX_HOME set when auth_mode='oauth_dir'.
 */

import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const spawnCalls: Array<{ args: string[]; opts: { env?: Record<string, string>; cwd?: string } }> = []

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
      const message = JSON.parse(chunk)
      if (message.method === 'initialize') {
        queueMicrotask(() => {
          stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { sessionId: 'sess', model: 'gpt-5', capabilities: {} },
          }) + '\n')
        })
      }
    }),
  }
  child.kill = vi.fn()
  return child
}

vi.mock('child_process', () => ({
  execSync: vi.fn(() => '/usr/local/bin/codex\n'),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '/usr/local/bin/codex\n', stderr: '', error: undefined })),
  spawn: vi.fn((_bin: string, args: string[], opts: { env?: Record<string, string>; cwd?: string }) => {
    spawnCalls.push({ args, opts })
    return makeChild()
  }),
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/switchboard-vitest') },
}))

describe('CodexAdapter — provider-instance env overlay', () => {
  beforeEach(() => {
    spawnCalls.length = 0
    vi.clearAllMocks()
  })

  it('merges resolvedEnv into the spawn env without dropping process env', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()

    process.env.PRE_EXISTING_PROBE = 'keep-me'
    await adapter.startSession({
      threadId: 't1',
      provider: 'codex',
      cwd: '/tmp/p',
      resolvedEnv: { OPENAI_API_KEY: 'sk-instance-xyz' },
    }, vi.fn())

    expect(spawnCalls.length).toBe(1)
    const env = spawnCalls[0].opts.env!
    expect(env.OPENAI_API_KEY).toBe('sk-instance-xyz')
    expect(env.PRE_EXISTING_PROBE).toBe('keep-me')
    delete process.env.PRE_EXISTING_PROBE
  })

  it('sets CODEX_HOME from resolvedOauthDir for oauth-dir multi-account', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()

    await adapter.startSession({
      threadId: 't2',
      provider: 'codex',
      cwd: '/tmp/p',
      resolvedOauthDir: '/tmp/codex-work',
    }, vi.fn())

    const env = spawnCalls[0].opts.env!
    expect(env.CODEX_HOME).toBe('/tmp/codex-work')
  })

  it('does not override CODEX_HOME when oauthDir is empty/null', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()

    process.env.CODEX_HOME = '/users/me/.codex'
    await adapter.startSession({
      threadId: 't3',
      provider: 'codex',
      cwd: '/tmp/p',
      resolvedOauthDir: null,
    }, vi.fn())

    const env = spawnCalls[0].opts.env!
    expect(env.CODEX_HOME).toBe('/users/me/.codex')
    delete process.env.CODEX_HOME
  })

  it('skips empty-string env values from resolvedEnv', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()

    await adapter.startSession({
      threadId: 't4',
      provider: 'codex',
      cwd: '/tmp/p',
      resolvedEnv: { OPENAI_API_KEY: '' },
    }, vi.fn())

    const env = spawnCalls[0].opts.env!
    expect(env.OPENAI_API_KEY).toBeUndefined()
  })
})
