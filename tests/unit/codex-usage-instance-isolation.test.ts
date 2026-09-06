/**
 * Item 1 (integration-level regression): exercises the REAL
 * `fetchInstanceUsage` -> `probe` -> `resolveInstanceEnv` path - the exact
 * seam the Settings "Usage" button uses - for three Codex instances live at
 * once: two named oauth_dir profiles ("Work", "Personal") and one default/
 * env-mode row, while an ambient CODEX_HOME leftover sits in process.env
 * (as it would if Switchboard were launched from a shell that had `codex
 * login`'d somewhere, or a previous profile's session left it set).
 *
 * Only the true I/O edges are stubbed: the DB row lookup (better-sqlite3's
 * prebuilt binary doesn't load under vitest's host Node - see
 * provider-instances-db.test.ts), Codex binary discovery, the login-shell
 * PATH probe, and the actual `codex app-server` spawn inside
 * `fetchCodexUsage`. `resolveInstanceEnv` and `buildCodexCliEnv` run for
 * real. Nothing here sends inference or reads a real credential.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'
import type { ProviderInstanceRow } from '../../src/main/db/providerInstances'

const rows = new Map<string, ProviderInstanceRow>()

function codexRow(overrides: Partial<ProviderInstanceRow>): ProviderInstanceRow {
  return {
    id: 'codex-default',
    agentType: 'codex',
    displayName: 'Default',
    accentColor: null,
    authMode: 'env',
    env: {},
    oauthDir: null,
    configJson: null,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

vi.mock('../../src/main/db/providerInstances', () => ({
  getProviderInstanceFull: vi.fn((id: string) => rows.get(id) ?? null),
}))

// The usage probe runs on the main event loop, so discovery reads the
// login-shell PATH through the non-blocking peek (behavior 5) - a warm cache
// here stands in for a warmup that has already landed.
vi.mock('../../src/main/shell-env', () => ({
  peekShellEnv: vi.fn(() => ({ PATH: '/usr/bin:/bin' })),
  warmShellEnv: vi.fn(async () => ({ PATH: '/usr/bin:/bin' })),
  loadShellEnv: vi.fn(() => ({ PATH: '/usr/bin:/bin' })),
  childProcessEnv: vi.fn(() => process.env),
  _resetShellEnvCacheForTests: vi.fn(),
}))

vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: vi.fn(),
  listSessionIdsForThread: vi.fn(() => []),
  resolveResumeSegment: vi.fn(() => null),
  resolveRootThreadId: (id: string) => id,
  conversationSessionHints: vi.fn(() => []),
}))

vi.mock('../../src/main/projects/session-scanner', () => ({
  scanCodexSessionCopies: vi.fn(() => []),
}))

vi.mock('../../src/main/provider/codex-session-dirs', () => ({
  codexCandidateDirs: () => [],
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/switchboard-vitest') },
}))

vi.mock('child_process', () => ({
  execSync: vi.fn(() => '/fake/bin/codex\n'),
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(new Error('not mocked'), '', '')),
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '', error: undefined })),
  spawn: vi.fn(),
}))

// Keeps buildCodexCliEnv (real, used by resolveInstanceEnv) while replacing
// findCodexPath so no real binary discovery/spawn happens.
vi.mock('../../src/main/provider/adapters/codex-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/adapters/codex-adapter')>()
  return { ...actual, findCodexPath: vi.fn(() => '/fake/bin/codex') }
})

const fetchCodexUsageCalls: Array<{ id: string; env: Record<string, string> }> = []

vi.mock('../../src/main/provider/usage/codex-usage', () => ({
  fetchCodexUsage: vi.fn((id: string, env: Record<string, string>) => {
    fetchCodexUsageCalls.push({ id, env })
    return Promise.resolve({
      instanceId: id,
      agentType: 'codex' as const,
      status: 'ok' as const,
      plan: null,
      account: null,
      windows: [],
      overage: [],
      message: '',
      fetchedAtMs: Date.now(),
    })
  }),
  disposeUsageProbes: vi.fn(),
}))

describe('fetchInstanceUsage - Codex multi-instance isolation (item 1)', () => {
  const savedCodexHome = process.env.CODEX_HOME

  beforeEach(() => {
    vi.clearAllMocks()
    rows.clear()
    fetchCodexUsageCalls.length = 0
  })

  afterEach(() => {
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = savedCodexHome
  })

  // canonicalizeOauthPath runs every home through node:path's normalize(),
  // which is platform-native by design; this fixture asserts an exact
  // POSIX-literal string round-trip, which only holds on a POSIX host - skip
  // on win32 rather than assert a separator style no real Windows install
  // would produce either (see oauth-path.ts).
  it.skipIf(process.platform === 'win32')('resolves distinct CODEX_HOME per instance through the real usage-probe path, and cache keys do not collapse', async () => {
    process.env.CODEX_HOME = '/tmp/ambient-leftover-codex-home'
    rows.set('codex-work', codexRow({
      id: 'codex-work', displayName: 'Work', authMode: 'oauth_dir', oauthDir: '/tmp/codex-work',
    }))
    rows.set('codex-personal', codexRow({
      id: 'codex-personal', displayName: 'Personal', authMode: 'oauth_dir', oauthDir: '/tmp/codex-personal',
    }))
    rows.set('codex-default', codexRow({ id: 'codex-default', displayName: 'Default' }))

    const { fetchInstanceUsage, invalidateUsage } = await import('../../src/main/provider/usage/index')
    invalidateUsage()

    const [work, personal, ambient] = await Promise.all([
      fetchInstanceUsage('codex-work'),
      fetchInstanceUsage('codex-personal'),
      fetchInstanceUsage('codex-default'),
    ])

    expect(work.instanceId).toBe('codex-work')
    expect(personal.instanceId).toBe('codex-personal')
    expect(ambient.instanceId).toBe('codex-default')

    const homeById = new Map(fetchCodexUsageCalls.map((c) => [c.id, c.env.CODEX_HOME]))
    expect(homeById.get('codex-work')).toBe('/tmp/codex-work')
    expect(homeById.get('codex-personal')).toBe('/tmp/codex-personal')
    expect(homeById.get('codex-default')).toBe(join(homedir(), '.codex'))

    // No collapse onto each other or onto the ambient leftover CODEX_HOME.
    expect(new Set(homeById.values()).size).toBe(3)
    expect([...homeById.values()]).not.toContain('/tmp/ambient-leftover-codex-home')

    // Cache keys are per-instance id: re-fetching "Work" must hit the cache
    // (no second probe call) and must not return "Personal"'s reading.
    const workAgain = await fetchInstanceUsage('codex-work')
    expect(workAgain.instanceId).toBe('codex-work')
    expect(fetchCodexUsageCalls.filter((c) => c.id === 'codex-work')).toHaveLength(1)
    expect(fetchCodexUsageCalls).toHaveLength(3)
  })
})
