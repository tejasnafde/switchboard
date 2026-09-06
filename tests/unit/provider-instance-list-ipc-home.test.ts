/**
 * Behavior 2, the IPC half: LIST is the authoritative layer.
 *
 * The DB layer cannot decrypt on LIST - that runs at every boot and would hit
 * the OS keychain - so it marks a row whose home only the ciphertext knows as
 * `unresolved`. Main fills those in before the renderer ever sees them, using
 * the real decrypted overlay, so Settings shows the directory the instance
 * actually runs under instead of a plausible default.
 *
 * Three properties matter: only the rows that need it are decrypted, the
 * result is memoized per row version (a keychain round-trip per LIST per row
 * is exactly the cost the env_keys column was added to avoid), and a row that
 * still cannot be read stays visibly `unresolved` rather than being given a
 * directory that might be wrong.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listMock = vi.hoisted(() => vi.fn())
const resolveMock = vi.hoisted(() => vi.fn())

vi.mock('../../src/main/db/providerInstances', () => ({
  listProviderInstances: listMock,
  resolveEffectiveOauthDir: resolveMock,
  upsertProviderInstance: vi.fn(),
  deleteProviderInstance: vi.fn(),
  getProviderInstanceFull: vi.fn(() => null),
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/switchboard-vitest') } }))

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}))

vi.mock('../../src/main/provider/instance-env', () => ({ resolveInstanceEnv: vi.fn(() => ({})) }))
vi.mock('../../src/main/provider/usage', () => ({
  fetchInstanceUsage: vi.fn(),
  invalidateUsage: vi.fn(),
}))
vi.mock('../../src/main/provider/adapters/claude-adapter', () => ({ findClaudeBin: vi.fn(() => null) }))
vi.mock('../../src/main/provider/adapters/codex-adapter', () => ({ findCodexPath: vi.fn(() => null) }))
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
    if (!fn) throw new Error(`no handler registered for ${channel}`)
    return (await fn(...args)) as T
  }
}

interface WireLike {
  id: string
  agentType: string
  updatedAt: number
  effectiveOauthDir: string | null
  effectiveOauthDirSource: string
}

function wire(over: Partial<WireLike> & { id: string }): WireLike {
  return {
    agentType: 'codex',
    updatedAt: 1,
    effectiveOauthDir: '/home/u/.codex',
    effectiveOauthDirSource: 'default',
    ...over,
  }
}

async function host(): Promise<FakeHost> {
  const { registerProviderInstanceHandlers } = await import('../../src/main/ipc/providerInstances')
  const h = new FakeHost()
  registerProviderInstanceHandlers(h)
  return h
}

describe('provider-instance LIST - authoritative effective home (behavior 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('fills in an unresolved row from the decrypted overlay', async () => {
    listMock.mockReturnValue([
      wire({ id: 'codex-default' }),
      wire({ id: 'codex-legacy', effectiveOauthDir: null, effectiveOauthDirSource: 'unresolved' }),
    ])
    resolveMock.mockReturnValue({ effectiveOauthDir: '/tmp/legacy', effectiveOauthDirSource: 'env' })

    const rows = await (await host()).invoke<WireLike[]>(ProviderInstanceChannels.LIST)
    expect(rows.find((r) => r.id === 'codex-legacy')).toMatchObject({
      effectiveOauthDir: '/tmp/legacy',
      effectiveOauthDirSource: 'env',
    })
  })

  it('decrypts only the rows that need it', async () => {
    listMock.mockReturnValue([
      wire({ id: 'a' }),
      wire({ id: 'b', effectiveOauthDir: '/tmp/x', effectiveOauthDirSource: 'oauth_dir' }),
      wire({ id: 'c', effectiveOauthDir: null, effectiveOauthDirSource: 'unresolved' }),
    ])
    resolveMock.mockReturnValue({ effectiveOauthDir: '/tmp/c', effectiveOauthDirSource: 'env' })

    await (await host()).invoke(ProviderInstanceChannels.LIST)
    expect(resolveMock).toHaveBeenCalledTimes(1)
    expect(resolveMock).toHaveBeenCalledWith('c')
  })

  it('memoizes per row version instead of decrypting on every LIST', async () => {
    listMock.mockReturnValue([
      wire({ id: 'c', updatedAt: 7, effectiveOauthDir: null, effectiveOauthDirSource: 'unresolved' }),
    ])
    resolveMock.mockReturnValue({ effectiveOauthDir: '/tmp/c', effectiveOauthDirSource: 'env' })

    const h = await host()
    await h.invoke(ProviderInstanceChannels.LIST)
    await h.invoke(ProviderInstanceChannels.LIST)
    expect(resolveMock).toHaveBeenCalledTimes(1)

    // A saved row is a new version, so the memo must not answer for it.
    listMock.mockReturnValue([
      wire({ id: 'c', updatedAt: 8, effectiveOauthDir: null, effectiveOauthDirSource: 'unresolved' }),
    ])
    await h.invoke(ProviderInstanceChannels.LIST)
    expect(resolveMock).toHaveBeenCalledTimes(2)
  })

  it('leaves a row visibly unresolved when the overlay cannot be read at all', async () => {
    listMock.mockReturnValue([
      wire({ id: 'c', effectiveOauthDir: null, effectiveOauthDirSource: 'unresolved' }),
    ])
    resolveMock.mockImplementation(() => { throw new Error('keychain unavailable') })

    const rows = await (await host()).invoke<WireLike[]>(ProviderInstanceChannels.LIST)
    expect(rows[0]).toMatchObject({ effectiveOauthDir: null, effectiveOauthDirSource: 'unresolved' })
  })

  it('still degrades to an empty list when the DB read itself fails', async () => {
    listMock.mockImplementation(() => { throw new Error('db gone') })
    expect(await (await host()).invoke(ProviderInstanceChannels.LIST)).toEqual([])
  })
})
