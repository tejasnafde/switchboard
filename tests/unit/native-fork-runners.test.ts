import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNativeForkRunners } from '../../src/main/conversations/native-fork-runners'
import { isUnsupportedMethodError } from '../../src/main/conversations/native-fork'

// Executable-script shims cannot be spawned on Windows, as elsewhere in the suite.
const itWithPosixToolShims = process.platform === 'win32' ? it.skip : it

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sb-native-fork-runner-'))
  dirs.push(dir)
  return dir
}

function executable(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!${process.execPath}\n${body}`)
  chmodSync(path, 0o755)
  return path
}

// A fake `codex app-server`: answers initialize, and thread/fork with the
// thread it would create, or with 0.144-era Codex's unknown-method error.
const FAKE_CODEX = `
const rl = require('readline').createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id === undefined) return
  if (m.method === 'initialize') return send({ id: m.id, result: { userAgent: 'fake' } })
  if (m.method === 'thread/fork' && process.env.FAKE_MODE === 'unknown') {
    return send({ id: m.id, error: { code: -32600, message: 'Invalid request: unknown variant \`thread/fork\`, expected one of \`thread/start\`' } })
  }
  if (m.method === 'thread/fork') {
    const p = m.params
    return send({ id: m.id, result: { thread: { id: 'fork-of-' + p.threadId + '-through-' + p.lastTurnId + (p.excludeTurns ? '' : '-with-turns'), path: '/codex/rollout.jsonl' } } })
  }
  send({ id: m.id, error: { code: -32601, message: 'method not found' } })
})
`

// A fake `opencode acp` built on the real ACP SDK's agent side.
const FAKE_OPENCODE = `
const { Readable, Writable } = require('stream')
const acp = require(${JSON.stringify(resolve('node_modules/@agentclientprotocol/sdk/dist/acp.js'))})
const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
if (process.env.FAKE_PID_FILE) {
  require('fs').writeFileSync(process.env.FAKE_PID_FILE, String(process.pid))
  process.on('SIGTERM', () => {})
}
new acp.AgentSideConnection(() => ({
  initialize: async () => ({
    protocolVersion: 1,
    agentCapabilities: process.env.FAKE_MODE === 'nofork' ? {} : { sessionCapabilities: { fork: {} } },
  }),
  unstable_forkSession: async (p) => ({ sessionId: 'forked-' + p.sessionId }),
  newSession: async () => ({ sessionId: 'new' }),
  authenticate: async () => ({}),
  prompt: async () => ({ stopReason: 'end_turn' }),
  cancel: async () => {},
}), stream)
`

function runners(dir: string, mode = '', extra: Record<string, string> = {}) {
  const env = { PATH: process.env.PATH ?? '', FAKE_MODE: mode, CODEX_HOME: join(dir, 'codex-home'), ...extra }
  return createNativeForkRunners(
    { codex: () => executable(dir, 'codex', FAKE_CODEX), opencode: () => executable(dir, 'opencode', FAKE_OPENCODE) },
    () => env,
    () => env,
  )
}

describe('native fork runners', () => {
  itWithPosixToolShims('forks a Codex thread through a turn over app-server', async () => {
    const dir = scratch()
    await expect(runners(dir).forkCodexThread('inst', { threadId: 't1', lastTurnId: 'turn-9', cwd: dir }))
      .resolves.toEqual({ threadId: 'fork-of-t1-through-turn-9', path: '/codex/rollout.jsonl' })
  })

  itWithPosixToolShims('surfaces a Codex without thread/fork as an unsupported method', async () => {
    const dir = scratch()
    const failure = await runners(dir, 'unknown')
      .forkCodexThread('inst', { threadId: 't1', lastTurnId: 'turn-9', cwd: dir })
      .catch((error: unknown) => error)
    expect(isUnsupportedMethodError(failure, 'thread/fork')).toBe(true)
  })

  it('reads a rollout only from the instance CODEX_HOME', async () => {
    const dir = scratch()
    const sessions = join(dir, 'codex-home', 'sessions', '2026', '09', '24')
    mkdirSync(sessions, { recursive: true })
    const id = '01a0b488-0000-7000-8000-00000000abcd'
    const content = JSON.stringify({ timestamp: '2026-09-24T10:00:00.000Z', type: 'session_meta', payload: { id, cwd: dir } }) + '\n'
    writeFileSync(join(sessions, `rollout-2026-09-24T10-00-00-${id}.jsonl`), content)

    await expect(runners(dir).readCodexRollout('inst', id)).resolves.toBe(content)
    await expect(runners(dir).readCodexRollout('inst', '01a0b488-0000-7000-8000-000000000000')).resolves.toBeNull()
  })

  itWithPosixToolShims('forks an OpenCode session over ACP when the agent advertises session/fork', async () => {
    const dir = scratch()
    await expect(runners(dir).forkOpencodeSession('inst', { sessionId: 'ses_1', cwd: dir }))
      .resolves.toBe('forked-ses_1')
  })

  itWithPosixToolShims('reports an OpenCode without session/fork as unsupported, without calling it', async () => {
    const dir = scratch()
    const failure = await runners(dir, 'nofork')
      .forkOpencodeSession('inst', { sessionId: 'ses_1', cwd: dir })
      .catch((error: unknown) => error)
    expect(isUnsupportedMethodError(failure, 'session/fork')).toBe(true)
  })

  itWithPosixToolShims('kills an OpenCode child that ignores SIGTERM', async () => {
    const dir = scratch()
    const pidFile = join(dir, 'pid')
    await runners(dir, 'nofork', { FAKE_PID_FILE: pidFile })
      .forkOpencodeSession('inst', { sessionId: 'ses_1', cwd: dir })
      .catch((error: unknown) => error)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    expect(alive()).toBe(true)
    await new Promise((done) => setTimeout(done, 2500))
    expect(alive()).toBe(false)
  })
})
