/**
 * Behavior 4: the `codex login status` credential probe must never block the
 * event loop.
 *
 * It runs on session start and on the chat-open auth preflight, and on a
 * remote the WsHost's message pump shares that loop - a `spawnSync` there
 * froze EVERY chat, PTY byte and streaming turn on the machine for as long as
 * the probe took (up to its 4s timeout, and longer when the box is slow to
 * fork). The fix is an async probe that is bounded, cached and deduplicated:
 *
 *   - bounded: a hard timeout, so a wedged CLI cannot pin the check open
 *   - cached: a verdict is reused briefly, so opening several chats against
 *     one remote does not spawn a process per chat
 *   - deduplicated: concurrent callers for the same dir share ONE child, so
 *     a burst of chat-opens cannot fork a burst of processes
 *
 * The mock below makes the synchronous child_process entry points throw, so
 * any regression back to a blocking probe fails here rather than in
 * production.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const probe = vi.hoisted(() => ({
  calls: [] as Array<{ args: string[]; opts: Record<string, unknown> }>,
  /** Resolve each pending child by hand so dedup is observable. */
  pending: [] as Array<() => void>,
  stdout: '',
  exitCode: 0 as number | null,
  manual: false,
}))

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => {
    throw new Error('spawnSync blocks the event loop - the login probe must be async')
  }),
  execFileSync: vi.fn(() => {
    throw new Error('execFileSync blocks the event loop - the login probe must be async')
  }),
  execFile: vi.fn((
    _bin: string,
    args: string[],
    opts: Record<string, unknown>,
    cb: (err: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void,
  ) => {
    probe.calls.push({ args, opts })
    const finish = (): void => {
      if (probe.exitCode === 0) cb(null, probe.stdout, '')
      else {
        const err = new Error(`exit ${probe.exitCode}`) as Error & { code?: number }
        err.code = probe.exitCode ?? 1
        cb(err, probe.stdout, 'Not logged in')
      }
    }
    if (probe.manual) probe.pending.push(finish)
    else queueMicrotask(finish)
    return { kill: vi.fn() }
  }),
}))

import {
  checkRemoteProviderAuth,
  remoteProviderLoginPrompt,
  __resetRemoteCodexLoginProbeCacheForTests,
} from '../../src/main/provider/remote-gate'

const LOGGED_IN = JSON.stringify({ loggedIn: true, account: { email: 'user@example.com' } })

describe('remote codex login probe - async, bounded, cached, deduped (behavior 4)', () => {
  const dirs: string[] = []
  const savedKey = process.env.OPENAI_API_KEY

  function tmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'sb-async-probe-'))
    dirs.push(dir)
    return dir
  }

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY
    probe.calls.length = 0
    probe.pending.length = 0
    probe.stdout = LOGGED_IN
    probe.exitCode = 0
    probe.manual = false
    __resetRemoteCodexLoginProbeCacheForTests()
  })

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = savedKey
  })

  it('probes without any synchronous child_process call', async () => {
    const result = await checkRemoteProviderAuth('codex', tmpDir())
    expect(result.loggedIn).toBe(true)
    expect(probe.calls).toHaveLength(1)
    expect(probe.calls[0].args).toEqual(['login', 'status'])
  })

  it('bounds the child with a timeout and pins CODEX_HOME to the probed dir', async () => {
    const dir = tmpDir()
    await checkRemoteProviderAuth('codex', dir)
    const opts = probe.calls[0].opts as { timeout?: number; env?: Record<string, string> }
    expect(typeof opts.timeout).toBe('number')
    expect(opts.timeout).toBeGreaterThan(0)
    expect(opts.timeout).toBeLessThanOrEqual(10_000)
    expect(opts.env?.CODEX_HOME).toBe(dir)
  })

  it('deduplicates concurrent probes of the same dir onto one child', async () => {
    probe.manual = true
    const dir = tmpDir()
    const inflight = Promise.all([
      checkRemoteProviderAuth('codex', dir),
      checkRemoteProviderAuth('codex', dir),
      checkRemoteProviderAuth('codex', dir),
      checkRemoteProviderAuth('codex', dir),
    ])
    await Promise.resolve()
    expect(probe.calls).toHaveLength(1)
    for (const done of probe.pending.splice(0)) done()
    const results = await inflight
    expect(results.every((r) => r.loggedIn)).toBe(true)
  })

  it('does not conflate two different config dirs', async () => {
    probe.manual = true
    const a = tmpDir()
    const b = tmpDir()
    const inflight = Promise.all([
      checkRemoteProviderAuth('codex', a),
      checkRemoteProviderAuth('codex', b),
    ])
    await Promise.resolve()
    expect(probe.calls).toHaveLength(2)
    for (const done of probe.pending.splice(0)) done()
    await inflight
  })

  it('caches a verdict so repeated chat-opens do not re-spawn', async () => {
    const dir = tmpDir()
    await checkRemoteProviderAuth('codex', dir)
    await checkRemoteProviderAuth('codex', dir)
    await checkRemoteProviderAuth('codex', dir)
    expect(probe.calls).toHaveLength(1)
  })

  it('reads a failed/timed-out probe as not logged in and keeps the login prompt', async () => {
    probe.exitCode = 1
    probe.stdout = ''
    const dir = tmpDir()
    expect((await checkRemoteProviderAuth('codex', dir)).loggedIn).toBe(false)
    expect(await remoteProviderLoginPrompt('codex', dir)).toContain('codex login --device-auth')
  })

  it('skips the probe entirely when OPENAI_API_KEY already answers the question', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    expect((await checkRemoteProviderAuth('codex', tmpDir())).loggedIn).toBe(true)
    expect(probe.calls).toHaveLength(0)
  })

  it('never probes for claude (no subprocess on that path at all)', async () => {
    expect((await checkRemoteProviderAuth('claude-code', tmpDir())).loggedIn).toBe(false)
    expect(probe.calls).toHaveLength(0)
  })
})

describe('remote codex login command quoting (behavior 6)', () => {
  it('POSIX-quotes a config dir that contains shell metacharacters', async () => {
    delete process.env.OPENAI_API_KEY
    probe.exitCode = 1
    probe.stdout = ''
    probe.manual = false
    __resetRemoteCodexLoginProbeCacheForTests()
    const dir = '/tmp/remote $(echo INJECTED)'
    const { loginCommand } = await checkRemoteProviderAuth('codex', dir)
    const { execFileSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const assignment = loginCommand.slice(0, loginCommand.length - ' codex login --device-auth'.length)
    const seen = execFileSync('/bin/sh', ['-c', `${assignment} sh -c 'printf %s "$CODEX_HOME"'`], {
      encoding: 'utf-8',
    })
    expect(seen).toBe(dir)
  })
})
