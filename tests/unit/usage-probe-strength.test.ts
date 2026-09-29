import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderUsage } from '../../src/shared/provider-usage'

/**
 * fetchInstanceUsage never runs two probes for one instance at once (each can
 * be a keychain password prompt), yet a forced request must not be handed an
 * unforced probe that was already in flight.
 */

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('../../src/main/db/provider-instances', () => ({
  getProviderInstanceFull: (id: string) => ({ id, agentType: 'claude-code', oauthDir: null }),
}))
vi.mock('../../src/main/provider/instance-env', () => ({ resolveInstanceEnv: () => ({}) }))
vi.mock('../../src/main/provider/adapters/codex-adapter', () => ({ findCodexPath: () => null }))
vi.mock('../../src/main/provider/usage/codex-usage', () => ({ fetchCodexUsage: vi.fn(), disposeUsageProbes: vi.fn() }))
vi.mock('../../src/main/provider/usage/claude-keychain', () => ({ forgetClaudeCredentialReads: vi.fn() }))

type Probe = { opts: { force?: boolean; refreshWithTurn?: boolean }; resolve: (u: ProviderUsage) => void }
const probes: Probe[] = []
let running = 0
let most = 0
vi.mock('../../src/main/provider/usage/claude-usage', () => ({
  fetchClaudeUsage: (id: string, _env: unknown, _dir: unknown, opts: Probe['opts']) => {
    most = Math.max(most, ++running)
    return new Promise<ProviderUsage>((resolve) => probes.push({
      opts,
      resolve: (u) => { running--; resolve(u) },
    }))
  },
}))

const { fetchInstanceUsage, invalidateUsage } = await import('../../src/main/provider/usage')

const reading = (message: string): ProviderUsage => ({
  instanceId: 'a', agentType: 'claude-code', status: 'ok', plan: null, account: null,
  windows: [], overage: [], message, fetchedAtMs: Date.now(),
})
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('usage probes for one instance', () => {
  beforeEach(() => {
    probes.length = 0
    running = 0
    most = 0
    invalidateUsage()
  })

  it('runs a forced request after an unforced probe in flight, not beside it or on its result', async () => {
    const plain = fetchInstanceUsage('a')
    const forced = fetchInstanceUsage('a', { force: true })
    await flush()
    expect(probes).toHaveLength(1)

    probes[0].resolve(reading('plain'))
    expect((await plain).message).toBe('plain')
    await flush()
    expect(probes).toHaveLength(2)
    expect(probes[1].opts.force).toBe(true)

    probes[1].resolve(reading('forced'))
    expect((await forced).message).toBe('forced')
    expect(most).toBe(1)
  })

  it('lets a weaker or equal request join a stronger probe in flight', async () => {
    const turn = fetchInstanceUsage('a', { refreshWithTurn: true })
    const forced = fetchInstanceUsage('a', { force: true })
    const plain = fetchInstanceUsage('a')
    const again = fetchInstanceUsage('a', { refreshWithTurn: true })
    await flush()
    expect(probes).toHaveLength(1)
    probes[0].resolve(reading('turn'))
    const results = await Promise.all([turn, forced, plain, again])
    expect(results.map((r) => r.message)).toEqual(['turn', 'turn', 'turn', 'turn'])
  })

  it('runs one probe for several forced requests waiting on the same older probe', async () => {
    const plain = fetchInstanceUsage('a')
    const forced = [fetchInstanceUsage('a', { force: true }), fetchInstanceUsage('a', { force: true })]
    await flush()
    probes[0].resolve(reading('plain'))
    await plain
    await flush()
    expect(probes).toHaveLength(2)
    probes[1].resolve(reading('forced'))
    expect((await Promise.all(forced)).map((r) => r.message)).toEqual(['forced', 'forced'])
    expect(most).toBe(1)
  })
})
