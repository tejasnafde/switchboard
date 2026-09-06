/**
 * Behavior 2, continued: the Settings "Test" result must name the credential
 * home the probe actually ran under.
 *
 * `testInstance` spawns the CLI with `resolveInstanceEnv(instance)` - which
 * honors a legacy env-mode profile's `CODEX_HOME`/`CLAUDE_CONFIG_DIR` overlay
 * - but built its "Run: ..." hint from `instance.oauthDir || '~/.codex'`.
 * For exactly the rows the overlay policy exists to keep working, that told
 * the user to log in to a DIFFERENT directory than the one just tested: they
 * run the command, `~/.codex` gets a fresh login, and the profile that
 * actually failed is still logged out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  full: vi.fn(),
  env: vi.fn(() => ({}) as Record<string, string>),
  exit: 1,
}))

vi.mock('../../src/main/db/providerInstances', () => ({
  listProviderInstances: vi.fn(() => []),
  resolveEffectiveOauthDir: vi.fn(() => null),
  upsertProviderInstance: vi.fn(),
  deleteProviderInstance: vi.fn(),
  getProviderInstanceFull: mocks.full,
}))

vi.mock('../../src/main/provider/instance-env', () => ({ resolveInstanceEnv: mocks.env }))

vi.mock('child_process', () => ({
  execFile: vi.fn((
    _bin: string,
    _args: string[],
    _opts: unknown,
    cb: (err: (Error & { code?: number }) | null, stdout: string, stderr: string) => void,
  ) => {
    if (mocks.exit === 0) cb(null, '', '')
    else {
      const err = new Error('failed') as Error & { code?: number }
      err.code = mocks.exit
      cb(err, '', 'Not logged in')
    }
  }),
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/switchboard-vitest') } }))
vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}))
vi.mock('../../src/main/provider/usage', () => ({ fetchInstanceUsage: vi.fn(), invalidateUsage: vi.fn() }))
vi.mock('../../src/main/provider/adapters/claude-adapter', () => ({ findClaudeBin: vi.fn(() => '/usr/bin/claude') }))
vi.mock('../../src/main/provider/adapters/codex-adapter', () => ({ findCodexPath: vi.fn(() => '/usr/bin/codex') }))
vi.mock('../../src/main/provider/adapters/opencode/env', () => ({
  findOpencodePath: vi.fn(() => null),
  buildOpencodeEnv: vi.fn(() => ({})),
}))

import { ProviderInstanceChannels } from '../../src/shared/ipc-channels'
import type { BackendHost } from '../../src/main/backend/host'

class FakeHost implements BackendHost {
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  handle(channel: string, fn: (...args: unknown[]) => unknown): void { this.handlers.set(channel, fn) }
  on(): void {}
  emit(): void {}
  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    const fn = this.handlers.get(channel)
    if (!fn) throw new Error(`no handler for ${channel}`)
    return (await fn(...args)) as T
  }
}

async function testInstance(id: string): Promise<{ ok: boolean; message: string }> {
  const { registerProviderInstanceHandlers } = await import('../../src/main/ipc/providerInstances')
  const host = new FakeHost()
  registerProviderInstanceHandlers(host)
  return host.invoke(ProviderInstanceChannels.TEST, id)
}

function instance(over: Record<string, unknown>) {
  return {
    id: 'x', agentType: 'codex', displayName: 'X', accentColor: null, authMode: 'env',
    env: {}, oauthDir: null, configJson: null, enabled: true, createdAt: 0, updatedAt: 0,
    ...over,
  }
}

describe('Settings Test probe - login hint names the tested home (behavior 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    mocks.exit = 1
  })

  it('points a failing legacy env-mode codex profile at its overlay home', async () => {
    mocks.full.mockReturnValue(instance({ env: { CODEX_HOME: '/tmp/legacy-codex' } }))
    mocks.env.mockReturnValue({ CODEX_HOME: '/tmp/legacy-codex' })

    const { ok, message } = await testInstance('x')
    expect(ok).toBe(false)
    expect(message).toContain('CODEX_HOME="/tmp/legacy-codex" codex login')
    expect(message).not.toContain('~/.codex')
  })

  it('points a failing legacy env-mode claude profile at its overlay home', async () => {
    mocks.full.mockReturnValue(instance({
      agentType: 'claude-code', env: { CLAUDE_CONFIG_DIR: '/tmp/legacy-claude' },
    }))
    mocks.env.mockReturnValue({ CLAUDE_CONFIG_DIR: '/tmp/legacy-claude' })

    const { ok, message } = await testInstance('x')
    expect(ok).toBe(false)
    expect(message).toContain('CLAUDE_CONFIG_DIR="/tmp/legacy-claude" claude auth login')
    expect(message).not.toContain('~/.claude')
  })

  it('still names an oauth_dir profile’s own directory', async () => {
    mocks.full.mockReturnValue(instance({ authMode: 'oauth_dir', oauthDir: '/tmp/codex-work' }))
    mocks.env.mockReturnValue({ CODEX_HOME: '/tmp/codex-work' })

    const { message } = await testInstance('x')
    expect(message).toContain('CODEX_HOME="/tmp/codex-work" codex login')
  })

  it('falls back to the canonical default when the env somehow names no home', async () => {
    mocks.full.mockReturnValue(instance({}))
    mocks.env.mockReturnValue({})

    const { message } = await testInstance('x')
    expect(message).toContain('CODEX_HOME="$HOME/.codex" codex login')
  })
})
