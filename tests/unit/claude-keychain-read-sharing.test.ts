import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Every keychain read `security` has no lasting access to is a macOS password
 * prompt. These pin how many reads a Claude usage load makes, with a fake
 * `security` runner: nothing here spawns the real tool or touches a keychain.
 */

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

const execFile = vi.fn()
vi.mock('child_process', () => ({ execFile: (...args: unknown[]) => execFile(...args) }))

const { claudeKeychainServiceCandidates, createClaudeCredentialReader } =
  await import('../../src/main/provider/usage/claude-keychain')

// A home with no credentials files, so every read goes to the fake keychain.
const home = mkdtempSync(join(tmpdir(), 'sb-keychain-read-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

const credential = JSON.stringify({
  claudeAiOauth: { accessToken: 'fixture-not-a-token', expiresAt: Date.now() + 3_600_000, scopes: [] },
})
const noPayload = JSON.stringify({ mcpOAuth: {} })

type Item = { payload: string } | 'blocked'

function fakeKeychain(items: Record<string, Item>) {
  const calls: string[] = []
  const runSecurity = vi.fn(async (service: string) => {
    calls.push(service)
    const item = items[service]
    if (!item) return { kind: 'absent' as const }
    if (item === 'blocked') return { kind: 'blocked' as const }
    return { kind: 'ok' as const, payload: item.payload }
  })
  /** Reads that reached an item: each is one password prompt at worst. */
  const prompts = (service: string) => calls.filter((s) => s === service).length
  return { runSecurity, calls, prompts }
}

function setup(items: Record<string, Item>) {
  let clock = 1_000_000
  const keychain = fakeKeychain(items)
  const reader = createClaudeCredentialReader({
    runSecurity: keychain.runSecurity,
    platform: 'darwin',
    homeDir: home,
    now: () => clock,
  })
  return {
    ...keychain,
    reader,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

const dirA = join(home, '.claude-a')
const dirB = join(home, '.claude-b')
const serviceA = claudeKeychainServiceCandidates(dirA, home)[0]
const serviceB = claudeKeychainServiceCandidates(dirB, home)[0]

describe('Claude keychain reads are shared by service', () => {
  beforeEach(() => execFile.mockReset())

  it('reads each service once for one Accounts load', async () => {
    const { reader, prompts } = setup({ [serviceA]: { payload: credential }, [serviceB]: { payload: credential } })
    const [a, b] = await Promise.all([reader.read(dirA, { owner: 'a' }), reader.read(dirB, { owner: 'b' })])
    expect(a.kind).toBe('found')
    expect(b.kind).toBe('found')
    expect(prompts(serviceA)).toBe(1)
    expect(prompts(serviceB)).toBe(1)
  })

  it('reads a service once for two instances that resolve to it', async () => {
    const { reader, prompts } = setup({ [serviceA]: { payload: credential } })
    // The trailing slash hashes differently, so its candidates include dirA's.
    const results = await Promise.all([reader.read(dirA, { owner: 'a' }), reader.read(`${dirA}/`, { owner: 'a2' })])
    expect(results.map((r) => r.kind)).toEqual(['found', 'found'])
    expect(prompts(serviceA)).toBe(1)

    // And again within the window, as the second of two callers would.
    await reader.read(dirA, { owner: 'a2' })
    expect(prompts(serviceA)).toBe(1)
  })

  it('reads the bare service once for two instances with no config dir', async () => {
    const { reader, prompts } = setup({ 'Claude Code-credentials': { payload: credential } })
    await Promise.all([reader.read(null, { owner: 'x' }), reader.read(null, { owner: 'y' })])
    expect(prompts('Claude Code-credentials')).toBe(1)
  })

  it('reads a found credential again once the window has passed', async () => {
    const { reader, prompts, advance } = setup({ [serviceA]: { payload: credential } })
    await reader.read(dirA)
    advance(46_000)
    await reader.read(dirA)
    expect(prompts(serviceA)).toBe(2)
  })

  it('does not retry an item without a credential under the next account', async () => {
    const { reader, prompts } = setup({ [serviceA]: { payload: noPayload } })
    const result = await reader.read(dirA, { owner: 'a' })
    expect(result.kind).toBe('missing')
    expect(prompts(serviceA)).toBe(1)
  })

  it('does not read an item without a credential again in the process', async () => {
    const { reader, prompts, advance } = setup({ [serviceA]: { payload: noPayload } })
    await reader.read(dirA, { owner: 'a' })
    advance(24 * 3_600_000)
    await reader.read(dirA, { owner: 'a' })
    await reader.read(dirA, { owner: 'other' })
    expect(prompts(serviceA)).toBe(1)
  })

  it('reads it again on the Usage refresh or once its instance is edited', async () => {
    const { reader, prompts } = setup({ [serviceA]: { payload: noPayload } })
    await reader.read(dirA, { owner: 'a' })
    await reader.read(dirA, { owner: 'a', fresh: true })
    expect(prompts(serviceA)).toBe(2)

    reader.forget('b')
    await reader.read(dirA, { owner: 'a' })
    expect(prompts(serviceA)).toBe(2)

    reader.forget('a')
    await reader.read(dirA, { owner: 'a' })
    expect(prompts(serviceA)).toBe(3)
  })

  it('does not keep a read that timed out on a prompt', async () => {
    const { reader, prompts } = setup({ [serviceA]: 'blocked' })
    expect((await reader.read(dirA)).kind).toBe('error')
    expect((await reader.read(dirA)).kind).toBe('error')
    expect(prompts(serviceA)).toBe(2)
  })

  it('runs a fresh read after one in flight rather than beside it', async () => {
    const { reader, runSecurity } = setup({ [serviceA]: { payload: credential } })
    let inFlight = 0
    let most = 0
    const inner = runSecurity.getMockImplementation()!
    runSecurity.mockImplementation(async (service: string, account: string | undefined) => {
      most = Math.max(most, ++inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return inner(service, account)
    })
    await Promise.all([reader.read(dirA), reader.read(dirA, { fresh: true })])
    expect(most).toBe(1)
    expect(runSecurity.mock.calls.filter(([s]) => s === serviceA)).toHaveLength(2)
  })

  it('neither keeps nor hands on a read in flight when its instance is edited', async () => {
    for (const forget of [
      (r: { forget(o?: string): void }) => r.forget('a'),
      (r: { forget(o?: string): void }) => r.forget(),
    ]) {
      const { reader, runSecurity, prompts } = setup({ [serviceA]: { payload: noPayload } })
      const inner = runSecurity.getMockImplementation()!
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      runSecurity.mockImplementationOnce(async (service: string, account: string | undefined) => {
        await gate
        return inner(service, account)
      })
      const pending = reader.read(dirA, { owner: 'a' })
      await new Promise((r) => setTimeout(r, 0))
      forget(reader)
      // Asked after the edit: waits for the old read, then reads again.
      const after = reader.read(dirA, { owner: 'a' })
      release()
      await Promise.all([pending, after])
      expect(prompts(serviceA)).toBe(2)
      // The post-edit read is the one kept.
      await reader.read(dirA, { owner: 'a' })
      expect(prompts(serviceA)).toBe(2)
    }
  })

  it('spawns nothing until something reads', async () => {
    createClaudeCredentialReader()
    await import('../../src/main/provider/usage/claude-keychain')
    expect(execFile).not.toHaveBeenCalled()
  })
})
