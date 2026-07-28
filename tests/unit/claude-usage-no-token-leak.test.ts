import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * The central security property of the usage feature: the OAuth access token
 * is read from the keychain, used as a Bearer header, and must never appear in
 * the value returned over IPC to the renderer (or in any message built from an
 * error path). This pins it so a future refactor cannot quietly regress it.
 */

// Assembled at runtime so the file contains no literal that resembles a real
// credential, which secret scanners and push protection would flag.
const TOKEN_PREFIX = ['sk', 'ant', 'oat01'].join('-')
const TOKEN = `${TOKEN_PREFIX}-NOT-A-REAL-TOKEN-FIXTURE`

const readClaudeCredential = vi.fn()

vi.mock('../../src/main/provider/usage/claude-keychain', () => ({
  readClaudeCredential: (...args: unknown[]) => readClaudeCredential(...args),
}))

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

const { fetchClaudeUsage } = await import('../../src/main/provider/usage/claude-usage')

const liveCredential = {
  kind: 'found' as const,
  source: 'keychain test',
  credential: {
    accessToken: TOKEN,
    expiresAtMs: Date.now() + 60 * 60_000,
    subscriptionType: 'team',
    scopes: ['user:inference', 'user:profile'],
  },
}

function expectNoToken(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(TOKEN)
  expect(JSON.stringify(value)).not.toContain(TOKEN_PREFIX)
}

describe('fetchClaudeUsage never leaks the access token', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    readClaudeCredential.mockReset()
    readClaudeCredential.mockResolvedValue(liveCredential)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('keeps it out of a successful result', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ five_hour: { utilization: 10, resets_at: null } }),
    }) as unknown as typeof fetch

    const usage = await fetchClaudeUsage('inst', { CLAUDE_CONFIG_DIR: '/tmp/x' }, '/tmp/x')
    expect(usage.status).toBe('ok')
    expectNoToken(usage)
  })

  it('sends it as a Bearer header and nowhere else', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ five_hour: { utilization: 1 } }),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await fetchClaudeUsage('inst', {}, null)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    // The URL must not carry it - that would put it in logs and proxies.
    expect(url).not.toContain(TOKEN)
  })

  it('keeps it out of a 401 result', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }) as unknown as typeof fetch
    const usage = await fetchClaudeUsage('inst', {}, null)
    expect(usage.status).toBe('unauthenticated')
    expectNoToken(usage)
  })

  it('keeps it out of a network-error result, even when the error text contains it', async () => {
    // A rejection message is interpolated into the user-facing message, so a
    // library that echoed the request would be the leak path.
    globalThis.fetch = vi.fn().mockRejectedValue(new Error(`connect failed for Bearer ${TOKEN}`)) as unknown as typeof fetch
    const usage = await fetchClaudeUsage('inst', {}, null)
    expect(usage.status).toBe('error')
    expect(usage.message).toBeDefined()
    expectNoToken(usage)
  })

  it('keeps it out of a non-JSON-body result', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new Error(`bad body ${TOKEN}`) },
    }) as unknown as typeof fetch
    const usage = await fetchClaudeUsage('inst', {}, null)
    expect(usage.status).toBe('error')
    expectNoToken(usage)
  })

  it('reports an expired credential without echoing it', async () => {
    readClaudeCredential.mockResolvedValue({
      ...liveCredential,
      credential: { ...liveCredential.credential, expiresAtMs: Date.now() - 1000 },
    })
    const usage = await fetchClaudeUsage('inst', { CLAUDE_CONFIG_DIR: '/tmp/x' }, '/tmp/x')
    expect(usage.status).toBe('expired')
    expectNoToken(usage)
  })

  it('short-circuits an API-key instance without reading a credential at all', async () => {
    const usage = await fetchClaudeUsage('inst', { ANTHROPIC_API_KEY: 'sk-ant-api-key' }, null)
    expect(usage.status).toBe('not-applicable')
    expect(readClaudeCredential).not.toHaveBeenCalled()
    expect(JSON.stringify(usage)).not.toContain('sk-ant-api-key')
  })
})

describe('fetchClaudeUsage network diagnostics', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    readClaudeCredential.mockReset()
    readClaudeCredential.mockResolvedValue(liveCredential)
  })
  afterEach(() => { globalThis.fetch = originalFetch })

  function undiciStyle(code: string): Error {
    // undici reports every transport failure as the bare string "fetch failed"
    // and hides the reason on .cause.
    const err = new Error('fetch failed')
    ;(err as Error & { cause?: unknown }).cause = Object.assign(new Error('connect error'), { code })
    return err
  }

  it('surfaces the cause code instead of a bare "fetch failed"', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(undiciStyle('ENOTFOUND')) as unknown as typeof fetch
    const usage = await fetchClaudeUsage('inst', {}, null)
    expect(usage.status).toBe('error')
    expect(usage.message).toContain('ENOTFOUND')
  })

  it('unwraps a happy-eyeballs AggregateError to its per-address codes', async () => {
    const err = new Error('fetch failed')
    ;(err as Error & { cause?: unknown }).cause = Object.assign(new AggregateError(
      [Object.assign(new Error('v6'), { code: 'ENETUNREACH' }), Object.assign(new Error('v4'), { code: 'ECONNREFUSED' })],
      'all attempts failed',
    ))
    globalThis.fetch = vi.fn().mockRejectedValue(err) as unknown as typeof fetch
    const usage = await fetchClaudeUsage('inst', {}, null)
    expect(usage.message).toContain('ENETUNREACH')
    expect(usage.message).toContain('ECONNREFUSED')
  })

  it('names the macOS DNS flush only for resolution failures', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(undiciStyle('ENOTFOUND')) as unknown as typeof fetch
    expect((await fetchClaudeUsage('i', {}, null)).message).toContain('mDNSResponder')

    globalThis.fetch = vi.fn().mockRejectedValue(undiciStyle('ECONNREFUSED')) as unknown as typeof fetch
    expect((await fetchClaudeUsage('i', {}, null)).message).not.toContain('mDNSResponder')
  })

  it('retries once on a transient failure and uses the second result', async () => {
    // A stale keep-alive socket after the machine sleeps fails on first use.
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(undiciStyle('ECONNRESET'))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ five_hour: { utilization: 7 } }) })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const usage = await fetchClaudeUsage('inst', {}, null)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(usage.status).toBe('ok')
    expect(usage.windows[0]?.usedPercent).toBe(7)
  })

  it('does not retry a timeout, which already consumed the full budget', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    const fetchMock = vi.fn().mockRejectedValue(timeout)
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const usage = await fetchClaudeUsage('inst', {}, null)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(usage.status).toBe('error')
  })

  it('gives up after one retry rather than looping', async () => {
    const fetchMock = vi.fn().mockRejectedValue(undiciStyle('ECONNRESET'))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const usage = await fetchClaudeUsage('inst', {}, null)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(usage.status).toBe('error')
    expectNoToken(usage)
  })
})
