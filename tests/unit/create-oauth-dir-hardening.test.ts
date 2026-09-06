/**
 * CREATE_OAUTH_DIR (Settings -> Providers "Create" button) shells out to
 * `mkdirSync` on a path the user typed. Behavior 6 contract:
 *   - created directories are 0700 (private to the user), not the default umask
 *   - `~`/`~/` is expanded before mkdir
 *   - a path that escapes the user's home (via `..`, an absolute path
 *     elsewhere, or a symlink hop) is rejected rather than created
 *
 * None of the escape/permission checks exist yet - this file pins the
 * contract against the real registered IPC handler so a fix can't
 * accidentally validate only the renderer's happy-path input.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mkdirCalls: Array<{ path: string; opts: unknown }> = []
const FAKE_HOME = '/fake/home/testuser'

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    mkdirSync: vi.fn((path: string, opts: unknown) => {
      mkdirCalls.push({ path, opts })
      return undefined
    }),
  }
})

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => FAKE_HOME }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/switchboard-vitest') },
}))

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}))

vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: vi.fn(),
  listSessionIdsForThread: vi.fn(() => []),
  resolveResumeSegment: vi.fn(() => null),
  resolveRootThreadId: (id: string) => id,
  conversationSessionHints: vi.fn(() => []),
  getSetting: vi.fn(() => null),
}))

vi.mock('../../src/main/projects/session-scanner', () => ({
  scanCodexSessionCopies: vi.fn(() => []),
}))

vi.mock('../../src/main/provider/codex-session-dirs', () => ({
  codexCandidateDirs: () => [],
}))

vi.mock('../../src/main/db/providerInstances', () => ({
  listProviderInstances: vi.fn(() => []),
  upsertProviderInstance: vi.fn(),
  deleteProviderInstance: vi.fn(),
  getProviderInstanceFull: vi.fn(() => null),
}))

vi.mock('../../src/main/provider/instance-env', () => ({
  resolveInstanceEnv: vi.fn(() => ({})),
}))

vi.mock('../../src/main/provider/usage', () => ({
  fetchInstanceUsage: vi.fn(),
  invalidateUsage: vi.fn(),
}))

import { ProviderInstanceChannels } from '../../src/shared/ipc-channels'
import type { BackendHost } from '../../src/main/backend/host'

class FakeHost implements BackendHost {
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn)
  }
  on(): void {}
  emit(): void {}
  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    const fn = this.handlers.get(channel)
    if (!fn) throw new Error(`no handler registered for ${channel}`)
    return (await fn(...args)) as T
  }
}

async function createHandler(): Promise<FakeHost> {
  const { registerProviderInstanceHandlers } = await import('../../src/main/ipc/providerInstances')
  const host = new FakeHost()
  registerProviderInstanceHandlers(host)
  return host
}

describe('CREATE_OAUTH_DIR hardening (behavior 6)', () => {
  beforeEach(() => {
    mkdirCalls.length = 0
    vi.clearAllMocks()
  })

  it('creates the directory with 0700 permissions', async () => {
    const host = await createHandler()
    const result = await host.invoke<{ ok: boolean; path?: string }>(
      ProviderInstanceChannels.CREATE_OAUTH_DIR,
      '~/.codex-work',
    )
    expect(result.ok).toBe(true)
    expect(mkdirCalls).toHaveLength(1)
    expect(mkdirCalls[0].opts).toMatchObject({ mode: 0o700 })
  })

  it('rejects a path that traverses outside the home directory', async () => {
    const host = await createHandler()
    const result = await host.invoke<{ ok: boolean; error?: string }>(
      ProviderInstanceChannels.CREATE_OAUTH_DIR,
      '~/.codex-work/../../etc/evil',
    )
    expect(result.ok).toBe(false)
    expect(mkdirCalls).toHaveLength(0)
  })

  it('rejects an absolute path outside the home directory', async () => {
    const host = await createHandler()
    const result = await host.invoke<{ ok: boolean; error?: string }>(
      ProviderInstanceChannels.CREATE_OAUTH_DIR,
      '/etc/some-other-dir',
    )
    expect(result.ok).toBe(false)
    expect(mkdirCalls).toHaveLength(0)
  })
})
