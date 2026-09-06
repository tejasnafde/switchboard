/**
 * `resolveInstanceEnv` is the one seam session spawn (codex-adapter.ts),
 * the Settings "Test" probe (ipc/providerInstances.ts), and the usage probe
 * (usage/index.ts) all resolve a Codex instance's env through - see the
 * doc-comment on instance-env.ts. Behaviors 1 and 3 pin its contract for
 * CODEX_HOME:
 *
 *   1. A Codex instance with no oauth_dir must resolve to the canonical
 *      absolute default home (`~/.codex`), never to whatever CODEX_HOME
 *      happens to be set in the ambient process env - that's a leftover
 *      from the shell/another instance, not this instance's credential.
 *   3. With several Codex instances live at once (two oauth_dir profiles
 *      plus a default/env-mode one), each must resolve independently -
 *      none of them may collapse onto the ambient value or onto each other.
 */
import { homedir } from 'os'
import { join } from 'path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ProviderInstanceRow } from '../../src/main/db/providerInstances'

vi.mock('child_process', () => ({
  execSync: vi.fn(() => '/usr/local/bin/codex\n'),
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(new Error('not mocked'), '', '')),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '/usr/local/bin/codex\n', stderr: '', error: undefined })),
  spawn: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/switchboard-vitest') },
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

describe('resolveInstanceEnv - codex ambient CODEX_HOME (behaviors 1 & 3)', () => {
  const savedCodexHome = process.env.CODEX_HOME

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = savedCodexHome
  })

  it('a no-oauth_dir instance ignores ambient CODEX_HOME and resolves the canonical default home', async () => {
    process.env.CODEX_HOME = '/tmp/some-ambient-codex-home'
    const { resolveInstanceEnv } = await import('../../src/main/provider/instance-env')
    const env = resolveInstanceEnv(codexRow({}))
    expect(env.CODEX_HOME).toBe(join(homedir(), '.codex'))
  })

  it('regression: two oauth_dir instances plus a third ambient-home instance never collapse onto one CODEX_HOME', async () => {
    process.env.CODEX_HOME = '/tmp/third-ambient-home'
    const { resolveInstanceEnv } = await import('../../src/main/provider/instance-env')

    const work = resolveInstanceEnv(codexRow({
      id: 'codex-work', displayName: 'Work', authMode: 'oauth_dir', oauthDir: '/tmp/codex-work',
    }))
    const personal = resolveInstanceEnv(codexRow({
      id: 'codex-personal', displayName: 'Personal', authMode: 'oauth_dir', oauthDir: '/tmp/codex-personal',
    }))
    const ambientDefault = resolveInstanceEnv(codexRow({}))

    expect(work.CODEX_HOME).toBe('/tmp/codex-work')
    expect(personal.CODEX_HOME).toBe('/tmp/codex-personal')
    expect(ambientDefault.CODEX_HOME).toBe(join(homedir(), '.codex'))
    expect(new Set([work.CODEX_HOME, personal.CODEX_HOME, ambientDefault.CODEX_HOME]).size).toBe(3)
  })
})
