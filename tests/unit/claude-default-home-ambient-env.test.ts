/**
 * Behaviors 1 and 3, the Claude half of the credential-home contract that
 * codex-default-home-ambient-env.test.ts pins for Codex.
 *
 * `CLAUDE_CONFIG_DIR` IS the account identity of a Claude Code session, the
 * same way `CODEX_HOME` is for Codex. Codex was fixed to pin the canonical
 * `~/.codex` for every instance that has no oauth_dir of its own; Claude was
 * left inheriting whatever `CLAUDE_CONFIG_DIR` happened to sit in the ambient
 * process env - the launching shell's, or a leftover from another profile.
 * On a machine where the user exports `CLAUDE_CONFIG_DIR` in their shell
 * profile, EVERY default-profile Claude session silently ran under that
 * account while the UI showed "Default".
 *
 * The precedence this file also pins (behavior 3), identical for both kinds:
 *
 *      instance oauth_dir  >  instance env overlay  >  canonical default
 *                                                      (never the ambient env)
 */
import { homedir } from 'os'
import { join } from 'path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ProviderInstanceRow } from '../../src/main/db/providerInstances'

vi.mock('child_process', () => ({
  execSync: vi.fn(() => '/usr/local/bin/claude\n'),
  execFile: vi.fn(),
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

function row(overrides: Partial<ProviderInstanceRow>): ProviderInstanceRow {
  return {
    id: 'claude-code-default',
    agentType: 'claude-code',
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

const CANONICAL_CLAUDE = join(homedir(), '.claude')
const CANONICAL_CODEX = join(homedir(), '.codex')

describe('resolveInstanceEnv - claude ambient CLAUDE_CONFIG_DIR (behavior 1)', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
  })

  it('a no-oauth_dir instance ignores ambient CLAUDE_CONFIG_DIR and pins the canonical default home', async () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/some-ambient-claude-home'
    const { resolveInstanceEnv } = await import('../../src/main/provider/instance-env')
    expect(resolveInstanceEnv(row({})).CLAUDE_CONFIG_DIR).toBe(CANONICAL_CLAUDE)
  })

  // canonicalizeOauthPath runs every home through node:path's normalize(),
  // which is platform-native by design; these fixtures assert an exact
  // POSIX-literal string round-trip, which only holds on a POSIX host - skip
  // on win32 rather than assert a separator style no real Windows install
  // would produce either (see oauth-path.ts).
  it.skipIf(process.platform === 'win32')('an explicit oauth_dir still wins over the ambient value', async () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/some-ambient-claude-home'
    const { resolveInstanceEnv } = await import('../../src/main/provider/instance-env')
    const env = resolveInstanceEnv(row({
      id: 'claude-code-work', authMode: 'oauth_dir', oauthDir: '/tmp/claude-work',
    }))
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/claude-work')
  })

  it('canonicalizes a tilde/relative oauth_dir instead of handing the CLI a literal ~', async () => {
    const { resolveInstanceEnv } = await import('../../src/main/provider/instance-env')
    const env = resolveInstanceEnv(row({ authMode: 'oauth_dir', oauthDir: '~/.claude-work/' }))
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(homedir(), '.claude-work'))
  })

  it('regression: several live claude instances never collapse onto one config dir', async () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/third-ambient-home'
    const { resolveInstanceEnv } = await import('../../src/main/provider/instance-env')
    const work = resolveInstanceEnv(row({ id: 'a', authMode: 'oauth_dir', oauthDir: '/tmp/claude-work' }))
    const personal = resolveInstanceEnv(row({ id: 'b', authMode: 'oauth_dir', oauthDir: '/tmp/claude-personal' }))
    const fallback = resolveInstanceEnv(row({}))
    expect(new Set([
      work.CLAUDE_CONFIG_DIR, personal.CLAUDE_CONFIG_DIR, fallback.CLAUDE_CONFIG_DIR,
    ]).size).toBe(3)
    expect(fallback.CLAUDE_CONFIG_DIR).toBe(CANONICAL_CLAUDE)
  })

  it('buildClaudeCliEnv drops the ambient value before any overlay can be applied', async () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/ambient-leftover'
    const { buildClaudeCliEnv } = await import('../../src/main/provider/adapters/claude-adapter')
    expect(buildClaudeCliEnv().CLAUDE_CONFIG_DIR).toBe(CANONICAL_CLAUDE)
  })
})

describe('resolveInstanceEnv - credential-home precedence (behavior 3)', () => {
  const savedClaude = process.env.CLAUDE_CONFIG_DIR
  const savedCodex = process.env.CODEX_HOME

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedClaude
    if (savedCodex === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = savedCodex
  })

  // Same POSIX-literal-fixture caveat as above.
  it.skipIf(process.platform === 'win32')('an env-overlay CLAUDE_CONFIG_DIR beats the default but loses to oauth_dir', async () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/ambient'
    const { resolveInstanceEnv } = await import('../../src/main/provider/instance-env')

    // Legacy env-mode profile: the structural var lives in the overlay. It
    // must keep running against the dir it was logged into - silently moving
    // it to ~/.claude would switch the user's account without telling them.
    const overlayOnly = resolveInstanceEnv(row({
      id: 'legacy', env: { CLAUDE_CONFIG_DIR: '/tmp/legacy-claude' },
    }))
    expect(overlayOnly.CLAUDE_CONFIG_DIR).toBe('/tmp/legacy-claude')

    const both = resolveInstanceEnv(row({
      id: 'both', authMode: 'oauth_dir', oauthDir: '/tmp/explicit-claude',
      env: { CLAUDE_CONFIG_DIR: '/tmp/legacy-claude' },
    }))
    expect(both.CLAUDE_CONFIG_DIR).toBe('/tmp/explicit-claude')
  })

  it('canonicalizes an env-overlay home the same way an oauth_dir is canonicalized', async () => {
    const { resolveInstanceEnv } = await import('../../src/main/provider/instance-env')
    expect(resolveInstanceEnv(row({ env: { CLAUDE_CONFIG_DIR: '~/.claude-legacy/' } })).CLAUDE_CONFIG_DIR)
      .toBe(join(homedir(), '.claude-legacy'))
    expect(resolveInstanceEnv(row({ agentType: 'codex', env: { CODEX_HOME: '~/.codex-legacy/' } })).CODEX_HOME)
      .toBe(join(homedir(), '.codex-legacy'))
  })

  // Same POSIX-literal-fixture caveat as above.
  it.skipIf(process.platform === 'win32')('applies the identical precedence to codex', async () => {
    process.env.CODEX_HOME = '/tmp/ambient-codex'
    const { resolveInstanceEnv } = await import('../../src/main/provider/instance-env')
    const codexRow = (o: Partial<ProviderInstanceRow>) => row({ agentType: 'codex', ...o })

    expect(resolveInstanceEnv(codexRow({})).CODEX_HOME).toBe(CANONICAL_CODEX)
    expect(resolveInstanceEnv(codexRow({ env: { CODEX_HOME: '/tmp/legacy-codex' } })).CODEX_HOME)
      .toBe('/tmp/legacy-codex')
    expect(resolveInstanceEnv(codexRow({
      authMode: 'oauth_dir', oauthDir: '/tmp/explicit-codex', env: { CODEX_HOME: '/tmp/legacy-codex' },
    })).CODEX_HOME).toBe('/tmp/explicit-codex')
  })

  it('does not let a claude instance overlay leak a CODEX_HOME identity (and vice versa)', async () => {
    const { resolveInstanceEnv } = await import('../../src/main/provider/instance-env')
    // A stray cross-kind var in an overlay is ordinary env, not this
    // instance's credential home: it must not change the home we resolve.
    expect(resolveInstanceEnv(row({ env: { CODEX_HOME: '/tmp/not-mine' } })).CLAUDE_CONFIG_DIR)
      .toBe(CANONICAL_CLAUDE)
    expect(resolveInstanceEnv(row({ agentType: 'codex', env: { CLAUDE_CONFIG_DIR: '/tmp/not-mine' } })).CODEX_HOME)
      .toBe(CANONICAL_CODEX)
  })
})
