import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { providerAuthState } from '../../src/shared/provider-auth-state'

const NOW = 1_800_000_000_000
const HOUR = 60 * 60_000

describe('providerAuthState', () => {
  it('treats an expired access token with a refresh token as signed in, pending refresh', () => {
    expect(providerAuthState({ credential: { expiresAtMs: NOW - 16 * HOUR, hasRefreshToken: true }, nowMs: NOW }))
      .toBe('refresh-pending')
  })

  it('treats an expired access token without a refresh token as logged out', () => {
    expect(providerAuthState({ credential: { expiresAtMs: NOW - HOUR, hasRefreshToken: false }, nowMs: NOW }))
      .toBe('logged-out')
  })

  it('treats a missing credential as logged out', () => {
    expect(providerAuthState({ credential: null, nowMs: NOW })).toBe('logged-out')
  })

  it('lets the CLI saying loggedIn false win over a fresh-looking credential', () => {
    expect(providerAuthState({
      cliLoggedIn: false,
      credential: { expiresAtMs: NOW + HOUR, hasRefreshToken: true },
      nowMs: NOW,
    })).toBe('logged-out')
  })

  it('trusts the CLI saying loggedIn true when no credential was read', () => {
    expect(providerAuthState({ cliLoggedIn: true, nowMs: NOW })).toBe('signed-in')
  })

  it('treats a live token as signed in', () => {
    expect(providerAuthState({ credential: { expiresAtMs: NOW + HOUR, hasRefreshToken: false }, nowMs: NOW }))
      .toBe('signed-in')
  })
})

const readClaudeCredential = vi.fn()
const withoutTurn = vi.fn()
const withTurn = vi.fn()

vi.mock('../../src/main/provider/usage/claude-keychain', () => ({
  readClaudeCredential: (...args: unknown[]) => readClaudeCredential(...args),
}))
vi.mock('../../src/main/provider/usage/claude-cli-refresh', () => ({
  refreshClaudeTokenWithoutTurn: (...args: unknown[]) => withoutTurn(...args),
  refreshClaudeTokenWithTurn: (...args: unknown[]) => withTurn(...args),
}))
vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

const { fetchClaudeUsage } = await import('../../src/main/provider/usage/claude-usage')

function found(expiresAtMs: number, hasRefreshToken = true) {
  return {
    kind: 'found' as const,
    source: 'test',
    credential: { accessToken: 'fixture', expiresAtMs, subscriptionType: 'max', scopes: ['user:profile'], hasRefreshToken },
  }
}

const ok = { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 12 } }) }
const env = { CLAUDE_CONFIG_DIR: '/tmp/x' }

describe('fetchClaudeUsage with an expired token', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    readClaudeCredential.mockReset()
    withoutTurn.mockReset().mockResolvedValue(true)
    withTurn.mockReset().mockResolvedValue(true)
  })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('asks the CLI to refresh without a turn, then reads usage with the new token', async () => {
    readClaudeCredential
      .mockResolvedValueOnce(found(Date.now() - 16 * HOUR))
      .mockResolvedValueOnce(found(Date.now() + 8 * HOUR))
    const fetchMock = vi.fn().mockResolvedValue(ok)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const usage = await fetchClaudeUsage('inst', env, '/tmp/x')
    expect(withoutTurn).toHaveBeenCalledWith(env)
    expect(withTurn).not.toHaveBeenCalled()
    expect(usage.status).toBe('ok')
  })

  it('reports signed in, usage after the next chat, when the CLI did not refresh', async () => {
    readClaudeCredential.mockResolvedValue(found(Date.now() - 16 * HOUR))
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const usage = await fetchClaudeUsage('inst', env, '/tmp/x')
    expect(usage.status).toBe('refresh-pending')
    expect(usage.message).toMatch(/^Signed in/)
    expect(usage.command).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('runs one CLI turn on Refresh now, then reads usage', async () => {
    readClaudeCredential
      .mockResolvedValueOnce(found(Date.now() - 16 * HOUR))
      .mockResolvedValueOnce(found(Date.now() + 8 * HOUR))
    globalThis.fetch = vi.fn().mockResolvedValue(ok) as unknown as typeof fetch

    const usage = await fetchClaudeUsage('inst', env, '/tmp/x', { refreshWithTurn: true })
    expect(withTurn).toHaveBeenCalledTimes(1)
    expect(withoutTurn).not.toHaveBeenCalled()
    expect(usage.status).toBe('ok')
  })

  it('reports logged out when Refresh now ran and the token is still stale', async () => {
    readClaudeCredential.mockResolvedValue(found(Date.now() - 16 * HOUR))
    withTurn.mockResolvedValue(false)
    const usage = await fetchClaudeUsage('inst', env, '/tmp/x', { refreshWithTurn: true })
    expect(withTurn).toHaveBeenCalledTimes(1)
    expect(usage.status).toBe('unauthenticated')
    expect(usage.command).toContain('claude auth login')
  })

  it('treats a 403 as a scope problem, not a pending refresh', async () => {
    readClaudeCredential.mockResolvedValue(found(Date.now() + 8 * HOUR))
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }) as unknown as typeof fetch
    expect((await fetchClaudeUsage('inst', env, '/tmp/x')).status).toBe('unauthenticated')
  })

  it('does not touch the CLI for a live token', async () => {
    readClaudeCredential.mockResolvedValue(found(Date.now() + 8 * HOUR))
    globalThis.fetch = vi.fn().mockResolvedValue(ok) as unknown as typeof fetch
    await fetchClaudeUsage('inst', env, '/tmp/x')
    expect(withoutTurn).not.toHaveBeenCalled()
    expect(withTurn).not.toHaveBeenCalled()
  })

  it('treats a 401 with a refresh token as pending, not logged out', async () => {
    readClaudeCredential.mockResolvedValue(found(Date.now() + 8 * HOUR))
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }) as unknown as typeof fetch
    expect((await fetchClaudeUsage('inst', env, '/tmp/x')).status).toBe('refresh-pending')
    // Still rejected after a real refresh turn: that is a logout.
    expect((await fetchClaudeUsage('inst', env, '/tmp/x', { refreshWithTurn: true })).status).toBe('unauthenticated')
  })

  it('reports logged out when the refresh token is missing, without asking the CLI', async () => {
    readClaudeCredential.mockResolvedValue(found(Date.now() - HOUR, false))
    const usage = await fetchClaudeUsage('inst', env, '/tmp/x')
    expect(usage.status).toBe('unauthenticated')
    expect(withoutTurn).not.toHaveBeenCalled()
  })
})
