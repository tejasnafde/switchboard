/**
 * Behavior 5: the login-shell environment probe must never block the main
 * process.
 *
 * `loadShellEnv()` spawns the user's login shell (`zsh -il -c 'env -0'`) and
 * waits for it synchronously, for up to 5 seconds. A Finder-launched Electron
 * app needs that PATH to find `codex`/`opencode` at all - but the lookups
 * that need it sit on the Settings "Test" probe, the usage probe, terminal
 * creation and session start, so a cold cache froze the whole app (every PTY,
 * every streaming turn) behind one shell start-up. Interactive login shells
 * source the user's full profile: nvm, pyenv, conda - seconds, routinely.
 *
 * The seam this pins:
 *   - `peekShellEnv()` NEVER blocks. Cold, it returns null and schedules the
 *     probe; warm, it returns the cached env.
 *   - `warmShellEnv()` does the probe asynchronously, process-wide, once -
 *     concurrent callers share one child, and a completed probe is not redone.
 *   - the two share one cache with the legacy synchronous `loadShellEnv()`,
 *     so nothing probes twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const shell = vi.hoisted(() => ({
  syncCalls: 0,
  asyncCalls: [] as string[][],
  pending: [] as Array<() => void>,
  manual: false,
  /** Flags whose probe succeeds; anything else exits non-zero. */
  okFlags: new Set(['-il']),
  env: 'PATH=/shell/bin:/usr/bin\0EDITOR=vim\0',
}))

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn((_shell: string, args: string[]) => {
    shell.syncCalls += 1
    return shell.okFlags.has(args[0])
      ? { status: 0, stdout: Buffer.from(shell.env), error: undefined }
      : { status: 1, stdout: Buffer.from(''), error: undefined }
  }),
  execFile: vi.fn((
    _shell: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string | Buffer, stderr: string) => void,
  ) => {
    shell.asyncCalls.push(args)
    const finish = (): void => {
      if (shell.okFlags.has(args[0])) cb(null, Buffer.from(shell.env), '')
      else cb(new Error('exit 1'), Buffer.from(''), '')
    }
    if (shell.manual) shell.pending.push(finish)
    else queueMicrotask(finish)
    return { kill: vi.fn() }
  }),
}))

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}))

async function loadModule() {
  return import('../../src/main/shell-env')
}

// The probe this file pins is POSIX-only by design: `unsupportedShell()` in
// `src/main/shell-env.ts` returns true unconditionally on win32 (no `/bin/sh`,
// no login-shell concept to probe), so `warmShellEnv`/`loadShellEnv`
// short-circuit to a cached `null` there regardless of the mocked child
// process below. Skip on win32 rather than assert against that stub, same as
// the `describePosix` split in pty-manager.test.ts.
const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('shell-env async warmup (behavior 5)', () => {
  const savedShell = process.env.SHELL

  beforeEach(async () => {
    vi.resetModules()
    shell.syncCalls = 0
    shell.asyncCalls.length = 0
    shell.pending.length = 0
    shell.manual = false
    shell.okFlags = new Set(['-il'])
    process.env.SHELL = '/bin/zsh'
    const mod = await loadModule()
    mod._resetShellEnvCacheForTests()
  })

  afterEach(() => {
    if (savedShell === undefined) delete process.env.SHELL
    else process.env.SHELL = savedShell
  })

  it('peekShellEnv returns null on a cold cache without spawning anything synchronously', async () => {
    const { peekShellEnv } = await loadModule()
    expect(peekShellEnv()).toBeNull()
    expect(shell.syncCalls).toBe(0)
  })

  it('peekShellEnv schedules the warmup it missed, and reports it once it lands', async () => {
    const { peekShellEnv, warmShellEnv } = await loadModule()
    expect(peekShellEnv()).toBeNull()
    await warmShellEnv()
    expect(peekShellEnv()?.PATH).toBe('/shell/bin:/usr/bin')
    expect(shell.syncCalls).toBe(0)
  })

  it('warmShellEnv probes asynchronously and parses the NUL-separated env', async () => {
    const { warmShellEnv } = await loadModule()
    const env = await warmShellEnv()
    expect(env).toMatchObject({ PATH: '/shell/bin:/usr/bin', EDITOR: 'vim' })
    expect(shell.syncCalls).toBe(0)
    expect(shell.asyncCalls).toHaveLength(1)
  })

  it('runs one child for concurrent warmups', async () => {
    shell.manual = true
    const { warmShellEnv } = await loadModule()
    const all = Promise.all([warmShellEnv(), warmShellEnv(), warmShellEnv()])
    await Promise.resolve()
    expect(shell.asyncCalls).toHaveLength(1)
    for (const done of shell.pending.splice(0)) done()
    const results = await all
    expect(results.every((r) => r?.PATH === '/shell/bin:/usr/bin')).toBe(true)
  })

  it('does not re-probe after a completed warmup', async () => {
    const { warmShellEnv } = await loadModule()
    await warmShellEnv()
    await warmShellEnv()
    expect(shell.asyncCalls).toHaveLength(1)
  })

  it('falls back from an interactive login shell to a plain login shell', async () => {
    shell.okFlags = new Set(['-l'])
    const { warmShellEnv } = await loadModule()
    expect((await warmShellEnv())?.PATH).toBe('/shell/bin:/usr/bin')
    expect(shell.asyncCalls.map((a) => a[0])).toEqual(['-il', '-l'])
  })

  it('caches a total failure as null instead of retrying on every lookup', async () => {
    shell.okFlags = new Set()
    const { warmShellEnv, peekShellEnv } = await loadModule()
    expect(await warmShellEnv()).toBeNull()
    expect(peekShellEnv()).toBeNull()
    await warmShellEnv()
    expect(shell.asyncCalls).toHaveLength(2) // -il then -l, once - not per call
  })

  it('shares its cache with the legacy synchronous loadShellEnv', async () => {
    const { warmShellEnv, loadShellEnv } = await loadModule()
    await warmShellEnv()
    expect(loadShellEnv()?.PATH).toBe('/shell/bin:/usr/bin')
    expect(shell.syncCalls).toBe(0) // answered from the warm cache, no new probe
  })

  it('does not let a later-completing async probe failure poison a good sync answer', async () => {
    // The boot warmup and a user-initiated machine connect race: the sync
    // probe answers first, then the async one lands. Its `.then` used to
    // assign unconditionally, so a failing async probe overwrote a perfectly
    // good cached PATH with null - for the rest of the process, leaving every
    // later provider lookup and ssh spawn on Finder's truncated PATH.
    const { warmShellEnv, loadShellEnv, peekShellEnv } = await loadModule()
    const warm = warmShellEnv()               // execFile queued, not yet run
    expect(loadShellEnv()?.PATH).toBe('/shell/bin:/usr/bin') // same tick, wins
    shell.okFlags = new Set()                 // the in-flight probe will fail
    expect(await warm).toMatchObject({ PATH: '/shell/bin:/usr/bin' })
    expect(peekShellEnv()?.PATH).toBe('/shell/bin:/usr/bin')
  })

  it('serves peekShellEnv from a cache the synchronous probe filled', async () => {
    const { loadShellEnv, peekShellEnv } = await loadModule()
    expect(loadShellEnv()?.PATH).toBe('/shell/bin:/usr/bin')
    expect(shell.syncCalls).toBe(1)
    expect(peekShellEnv()?.PATH).toBe('/shell/bin:/usr/bin')
    expect(shell.asyncCalls).toHaveLength(0)
  })
})
