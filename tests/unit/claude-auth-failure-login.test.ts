/**
 * A Claude login whose `.credentials.json` is still on disk but no longer
 * works (seen on a VM after weeks unused): the CLI answers a turn with
 * `authentication_failed`. The adapter remembers that for the config folder,
 * so the remote login check, and with it `list_machines`, stops counting the
 * account until the file changes (a new sign-in or a token refresh).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ error: 'authentication_failed' }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { prompt: AsyncIterable<unknown> }) => ({
    async *[Symbol.asyncIterator]() {
      for await (const _ of args.prompt) {
        yield {
          type: 'assistant',
          error: sdk.error,
          parent_tool_use_id: null,
          message: { model: '<synthetic>', content: [{ type: 'text', text: 'Please run /login' }] },
        }
        yield { type: 'result', subtype: 'success', is_error: true, result: 'Please run /login' }
      }
    },
    interrupt: vi.fn(),
    setPermissionMode: vi.fn(),
    getContextUsage: vi.fn(async () => ({})),
    close: vi.fn(),
  })),
}))

vi.mock('../../src/main/provider/managed-bin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/managed-bin')>()
  return { ...actual, createExecutableCache: () => ({ refresh: () => null, current: () => null }) }
})

import { ClaudeAdapter } from '../../src/main/provider/adapters/claude-adapter'
import { checkRemoteProviderAuth, noteClaudeAuthFailure } from '../../src/main/provider/remote-gate'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function signedInDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sb-claude-auth-'))
  dirs.push(dir)
  writeFileSync(join(dir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"a"}}')
  return dir
}

async function runTurn(oauthDir: string, instanceEnv: Record<string, string> = {}): Promise<void> {
  const adapter = new ClaudeAdapter()
  const onEvent = vi.fn()
  await adapter.startSession(
    {
      threadId: 't1',
      provider: 'claude',
      cwd: tmpdir(),
      runtimeMode: 'sandbox',
      resolvedEnv: instanceEnv,
      resolvedOauthDir: oauthDir,
    },
    onEvent,
  )
  await adapter.sendTurn('t1', 'hi', 'sandbox')
  await vi.waitFor(() => expect(onEvent.mock.calls.some(([e]) => e.type === 'turn.completed')).toBe(true))
  await adapter.stopSession('t1')
}

describe('a Claude login that the CLI refused', () => {
  it('stops counting as signed in until the credentials file changes', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    const dir = signedInDir()
    expect((await checkRemoteProviderAuth('claude-code', dir)).loggedIn).toBe(true)
    noteClaudeAuthFailure(dir)
    expect((await checkRemoteProviderAuth('claude-code', dir)).loggedIn).toBe(false)
    writeFileSync(join(dir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"a new one"}}')
    expect((await checkRemoteProviderAuth('claude-code', dir)).loggedIn).toBe(true)
  })

  it('is noted by the adapter on authentication_failed for the session folder', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    sdk.error = 'authentication_failed'
    const dir = signedInDir()
    await runTurn(dir)
    expect((await checkRemoteProviderAuth('claude-code', dir)).loggedIn).toBe(false)
  })

  it('is not noted for another API error, or when a key in the env did the signing in', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    sdk.error = 'server_error'
    const other = signedInDir()
    await runTurn(other)
    expect((await checkRemoteProviderAuth('claude-code', other)).loggedIn).toBe(true)
    sdk.error = 'authentication_failed'
    const keyed = signedInDir()
    await runTurn(keyed, { CLAUDE_CODE_OAUTH_TOKEN: 'tok' })
    expect((await checkRemoteProviderAuth('claude-code', keyed)).loggedIn).toBe(true)
  })
})
