/**
 * A saved secret never reaches a log: Codex wire frames (SB_CODEX_WIRE_LOG),
 * Codex and Claude stderr split across chunks, and raw Codex error params,
 * through the real adapters and the real file logger.
 */
import { EventEmitter } from 'events'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { PassThrough } from 'stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CANARY = 'sbcanary_7_0123456789'
const MASK = '[secret LOG_KEY]'
/** The adapters start under a loaded full-suite run, so give them longer than the 1 s default. */
const WAIT = { timeout: 10_000 }

const fake = vi.hoisted(() => {
  process.env.SB_CODEX_WIRE_LOG = '1'
  return {
    child: null as null | (EventEmitter & { stdout: PassThrough; stderr: EventEmitter }),
    stderr: null as null | ((data: string) => void),
  }
})

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execSync: vi.fn(() => '/usr/local/bin/codex\n'),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '/usr/local/bin/codex\n', stderr: '', error: undefined })),
  spawn: vi.fn(() => {
    const stdout = new PassThrough()
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>
    child.stdout = stdout
    child.stderr = new EventEmitter()
    child.stdin = {
      writable: true,
      write: (chunk: string) => {
        const message = JSON.parse(chunk)
        if (message.method === 'initialize')
          queueMicrotask(() =>
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } })}\n`),
          )
      },
    }
    child.kill = vi.fn()
    fake.child = child as typeof fake.child
    return child
  }),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { prompt: AsyncIterable<unknown>; options: { stderr?: (data: string) => void } }) => {
    fake.stderr = args.options.stderr ?? null
    return {
      async *[Symbol.asyncIterator]() {
        await args.prompt[Symbol.asyncIterator]().next()
        await new Promise(() => {})
      },
      interrupt: vi.fn(),
      setPermissionMode: vi.fn(),
      getContextUsage: vi.fn(async () => ({})),
      close: vi.fn(),
    }
  }),
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/switchboard-vitest') } }))

vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: vi.fn(),
  listSessionIdsForThread: vi.fn(() => []),
  resolveResumeSegment: vi.fn(() => null),
  resolveRootThreadId: (id: string) => id,
  conversationSessionHints: vi.fn(() => []),
}))
vi.mock('../../src/main/projects/session-scanner', () => ({ scanCodexSessionCopies: vi.fn(() => []) }))
vi.mock('../../src/main/provider/codex-session-dirs', () => ({ codexCandidateDirs: () => [] }))

const consoleText: string[] = []

async function logged(): Promise<string> {
  const { flushLogsSync, getLogDir } = await import('../../src/main/logger')
  flushLogsSync()
  const dir = getLogDir()
  const files = readdirSync(dir).filter((f) => f.endsWith('.log'))
  return [...consoleText, ...files.map((f) => readFileSync(join(dir, f), 'utf8'))].join('\n')
}

describe('saved secrets in logs', () => {
  beforeEach(async () => {
    consoleText.length = 0
    for (const method of ['debug', 'log', 'info', 'warn', 'error'] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleText.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      })
    const { secretRedactor } = await import('../../src/main/secrets/secret-redactor')
    secretRedactor.add('t1', 'sec_log', 'LOG_KEY', Buffer.from(CANARY))
  })

  afterEach(async () => {
    const { secretRedactor } = await import('../../src/main/secrets/secret-redactor')
    secretRedactor.clear()
    vi.restoreAllMocks()
  })

  it('masks Codex wire frames, split stderr and error params', async () => {
    const { CodexAdapter } = await import('../../src/main/provider/adapters/codex-adapter')
    const adapter = new CodexAdapter()
    await adapter.startSession({ threadId: 't1', provider: 'codex', cwd: '/tmp/p' }, vi.fn())
    const child = fake.child!
    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'item/commandExecution/outputDelta',
        params: { threadId: 'x', itemId: 'i', delta: `cat key\n${CANARY}\n` },
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'error', params: { error: { message: 'boom' }, detail: CANARY } })}\n`,
    )
    child.stderr.emit('data', Buffer.from(`warn: token ${CANARY.slice(0, 12)}`))
    child.stderr.emit('data', Buffer.from(`${CANARY.slice(12)} rejected\n`))
    await vi.waitFor(async () => expect(await logged()).toContain(`codex stderr: warn: token ${MASK} rejected`), WAIT)
    const text = await logged()
    expect(text).toContain(`codex -> `)
    expect(text).not.toContain(CANARY)
    expect(text).not.toContain(CANARY.slice(0, 12))
    await adapter.stopSession('t1')
  })

  it('masks Claude stderr split across chunks', async () => {
    const { ClaudeAdapter } = await import('../../src/main/provider/adapters/claude-adapter')
    const adapter = new ClaudeAdapter()
    await adapter.startSession({ threadId: 't1', provider: 'claude', cwd: '/tmp', runtimeMode: 'sandbox' }, vi.fn())
    await adapter.sendTurn('t1', 'go', 'sandbox')
    await vi.waitFor(() => expect(fake.stderr).not.toBeNull(), WAIT)
    fake.stderr!(`debug ${CANARY.slice(0, 10)}`)
    fake.stderr!(`${CANARY.slice(10)}\n`)
    await adapter.stopSession('t1')
    const text = await logged()
    expect(text).toContain(`claude stderr: debug ${MASK}`)
    expect(text).not.toContain(CANARY.slice(0, 10))
  })
})
