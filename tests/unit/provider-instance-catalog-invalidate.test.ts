/**
 * An edited or deleted instance points at different credentials, so its
 * cached model list must not outlive the change.
 */
import { describe, expect, it, vi } from 'vitest'

const invalidateCatalog = vi.hoisted(() => vi.fn())

vi.mock('../../src/main/db/provider-instances', () => ({
  listProviderInstances: vi.fn(() => []),
  resolveEffectiveOauthDir: vi.fn(),
  upsertProviderInstance: vi.fn((input: { id?: string }) => ({
    id: input.id ?? 'new',
    agentType: 'claude-code',
    authMode: 'env',
    oauthDir: null,
  })),
  deleteProviderInstance: vi.fn(() => true),
  getProviderInstanceFull: vi.fn(() => null),
}))
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/switchboard-vitest') } }))
vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}))
vi.mock('../../src/main/provider/instance-env', () => ({ resolveInstanceEnv: vi.fn(() => ({})) }))
vi.mock('../../src/main/provider/usage', () => ({ fetchInstanceUsage: vi.fn(), invalidateUsage: vi.fn() }))
vi.mock('../../src/main/provider/catalog-probe', () => ({ invalidateCatalog }))
vi.mock('../../src/main/provider/adapters/claude-adapter', () => ({ findClaudeBin: vi.fn(() => null) }))
vi.mock('../../src/main/provider/adapters/codex-adapter', () => ({ findCodexPath: vi.fn(() => null) }))
vi.mock('../../src/main/provider/adapters/opencode/env', () => ({
  findOpencodePath: vi.fn(() => null),
  buildOpencodeEnv: vi.fn(() => ({})),
}))

import { ProviderInstanceChannels } from '../../src/shared/ipc-channels'
import type { BackendHost } from '../../src/main/backend/host'
import { registerProviderInstanceHandlers } from '../../src/main/ipc/provider-instances'

class FakeHost implements BackendHost {
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn)
  }
  on(): void {}
  emit(): void {}
  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    return (await this.handlers.get(channel)!(...args)) as T
  }
}

describe('provider instance edits invalidate the model catalog', () => {
  it.each([
    [
      'upsert',
      ProviderInstanceChannels.UPSERT,
      { id: 'claude-work', agentType: 'claude-code', displayName: 'work', authMode: 'env' },
    ],
    ['delete', ProviderInstanceChannels.DELETE, 'claude-work'],
  ] as const)('on %s', async (_name, channel, arg) => {
    const host = new FakeHost()
    registerProviderInstanceHandlers(host)
    invalidateCatalog.mockClear()
    await host.invoke(channel, arg)
    expect(invalidateCatalog).toHaveBeenCalledOnce()
  })
})
