/**
 * Behavior 10 (packaged discovery) crossed with behavior 5 (never block).
 *
 * A Finder-launched Electron app gets a truncated PATH, so a `codex` the user
 * installed somewhere only their login shell knows about - not Switchboard's
 * managed bin dir, not any codex-adapter fallback dir - is invisible unless
 * discovery consults the login-shell PATH.
 *
 * It must consult it WITHOUT waiting for it. `findCodexPath()` runs on
 * session start, the Settings "Test" probe and the usage probe; blocking
 * those on an interactive login shell (seconds, routinely) freezes every PTY
 * and streaming turn in the app. So discovery reads the shell PATH through
 * the non-blocking `peekShellEnv()`: cold, it finds nothing extra and returns
 * promptly; once the process-wide warmup lands, the same lookup resolves the
 * shell-only binary. `codexExecutable` revalidates, so that later answer is
 * the one a session actually spawns.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const SHELL_ONLY_DIR = '/custom/shell/only/bin'
const SHELL_ONLY_CODEX = `${SHELL_ONLY_DIR}/codex`

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    accessSync: vi.fn((path: string) => {
      if (path === SHELL_ONLY_CODEX) return undefined
      throw new Error(`ENOENT: ${path}`)
    }),
  }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/switchboard-vitest') },
}))

vi.mock('child_process', () => ({
  execSync: vi.fn(() => { throw new Error('not found') }),
  // Simulates `which codex` finding nothing on the naive (Finder-truncated)
  // PATH that `buildCodexCliEnv()` builds today.
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '', error: undefined })),
  spawn: vi.fn(),
}))

vi.mock('../../src/main/db/database', () => ({
  conversationSessionHints: vi.fn(() => []),
  resolveResumeSegment: vi.fn(() => null),
}))

vi.mock('../../src/main/projects/session-scanner', () => ({
  scanCodexSessionCopies: vi.fn(() => []),
}))

vi.mock('../../src/main/provider/codex-session-dirs', () => ({
  codexCandidateDirs: () => [],
}))

// A shell-env whose cache starts COLD: peek answers null until the warmup
// resolves, exactly as the real module behaves on a freshly launched app.
// `loadShellEnv` is deliberately a thrower - discovery must never reach for
// the blocking form.
const shellEnv = vi.hoisted(() => ({ warm: false }))

vi.mock('../../src/main/shell-env', () => ({
  peekShellEnv: vi.fn(() => (shellEnv.warm ? { PATH: `${SHELL_ONLY_DIR}:/usr/bin:/bin` } : null)),
  warmShellEnv: vi.fn(async () => {
    shellEnv.warm = true
    return { PATH: `${SHELL_ONLY_DIR}:/usr/bin:/bin` }
  }),
  loadShellEnv: vi.fn(() => {
    throw new Error('discovery must not block on the synchronous shell probe')
  }),
  childProcessEnv: vi.fn(() => ({ ...process.env })),
  _resetShellEnvCacheForTests: vi.fn(),
}))

describe('findCodexPath - packaged/Finder discovery (behavior 10)', () => {
  const savedHome = process.env.HOME
  const savedManaged = process.env.SWITCHBOARD_MANAGED_BIN

  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    shellEnv.warm = false
    process.env.HOME = '/Users/sb-test-home'
    delete process.env.SWITCHBOARD_MANAGED_BIN
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedManaged === undefined) delete process.env.SWITCHBOARD_MANAGED_BIN
    else process.env.SWITCHBOARD_MANAGED_BIN = savedManaged
  })

  it('finds a codex that only exists on the login-shell PATH, not the managed dir or any fallback dir', async () => {
    const { findCodexPath } = await import('../../src/main/provider/adapters/codex-adapter')
    const { warmShellEnv } = await import('../../src/main/shell-env')
    await warmShellEnv()
    expect(findCodexPath()).toBe(SHELL_ONLY_CODEX)
  })

  it('returns promptly on a cold cache instead of waiting for the login shell', async () => {
    const { findCodexPath } = await import('../../src/main/provider/adapters/codex-adapter')
    const { peekShellEnv, loadShellEnv } = await import('../../src/main/shell-env')
    // Cold: nothing on the managed dir, the fallback dirs or the naive PATH,
    // and the shell PATH is not known yet - so the answer is "not found",
    // arrived at without ever touching the blocking probe.
    expect(findCodexPath()).toBeNull()
    expect(loadShellEnv).not.toHaveBeenCalled()
    expect(peekShellEnv).toHaveBeenCalled()
  })

  it('resolves once the warmup lands, without a restart', async () => {
    const { findCodexPath } = await import('../../src/main/provider/adapters/codex-adapter')
    const { warmShellEnv } = await import('../../src/main/shell-env')
    expect(findCodexPath()).toBeNull()
    await warmShellEnv()
    expect(findCodexPath()).toBe(SHELL_ONLY_CODEX)
  })
})
