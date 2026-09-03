/**
 * Regression: reopening a chat whose Claude provider session is recorded
 * against a different, now-inactive OAuth profile (live forensics on
 * conversation e3e47f38-f8dc-4083-88f3-b40d8fc193b0 - its transcript sat
 * intact under one profile's projects dir while a fresh session got created
 * under another). `resolveClaudeResumeId` correctly finds the DB-recorded
 * (typed) provider session id via `resolveResumeSegment`/`listSessionIdsForThread`
 * and returns it as `ClaudeAdapter.startSession`'s resolved `session.sessionId`.
 *
 * `ProviderRegistry.startSession` used to immediately stomp on that: it seeded
 * `latestSessionId` from the raw, unvalidated `opts.resumeSessionId` (whatever
 * the client's local store last cached) and unconditionally copied it onto the
 * returned `session` object once startSession resolved. Claude never fires a
 * synchronous `session` event during `startSession` (only later, mid-turn, from
 * `runQuery`), so `latestSessionId` never advanced past that raw hint - and
 * since `session` here is the exact object ClaudeAdapter also keeps as
 * `active.session`, the registry's write clobbered the adapter's own resolved
 * id in place. The next turn's resume pre-flight then read the clobbered
 * (wrong) id straight out of `active.session.sessionId`, so migration could
 * never find the transcript.
 */
import { describe, expect, it, vi } from 'vitest'

const STORED_ID = '55555555-5555-4555-8555-555555555555' // DB-recorded resume id; its transcript lives in "another configured OAuth profile"
const STALE_HINT = '66666666-6666-4666-8666-666666666666' // stale id the client's local store still remembers - must lose to STORED_ID

vi.mock('../../src/main/db/providerInstances', () => ({
  resolveProviderInstance: (agentType: string, id?: string) => ({
    id: id ?? `${agentType}-default`,
    agentType,
    displayName: id ?? `${agentType}-default`,
    enabled: true,
    env: {},
    oauthDir: null,
  }),
  getProviderInstanceFull: (id: string) => ({
    id, agentType: 'claude-code', displayName: id, enabled: true, env: {}, oauthDir: null,
  }),
  listOauthDirsForAgent: () => [],
}))

vi.mock('../../src/main/provider/remote-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/remote-gate')>()
  return { ...actual, remoteProviderLoginPrompt: () => null }
})

vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: vi.fn(),
  recordConversationSegment: vi.fn(),
  updateConversationSessionId: vi.fn(),
  saveMessageIfAbsent: () => true,
  getMessageForConversationById: () => undefined,
  getConversationRuntimeMode: () => null,
  getConversationModel: () => null,
  getConversationAgentType: () => null,
  getConversationProviderInstanceId: () => null,
  getConversationTitle: () => null,
  getConversationById: (id: string) => ({ id }),
  // The reopened thread id IS the root - "stable Switchboard conversation/thread id".
  resolveRootThreadId: (id: string) => id,
  getSetting: () => null,
  setConversationProviderInstanceId: () => {},
  commitConversationProviderSwitch: () => {},
  // The typed segment - what actually got recorded when the OAuth profile that
  // owns this transcript last ran the session.
  resolveResumeSegment: (_threadId: string, agentType: string) =>
    agentType === 'claude-code' ? { provider_session_id: STORED_ID } : null,
  listSessionIdsForThread: () => [STORED_ID],
}))

vi.mock('../../src/main/provider/claude-session-migrate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/claude-session-migrate')>()
  return {
    ...actual,
    ensureClaudeSessionResumable: vi.fn(() => ({ ok: true as const, copied: false })),
    prepareClaudeProfileSwitch: vi.fn(),
    claudeCandidateDirs: () => ['/profile-b'],
    // Only STORED_ID has a transcript anywhere - the stale hint has none.
    listClaudeSessionCopies: (dir: string, id: string) =>
      dir === '/profile-b' && id === STORED_ID ? [{ id, path: `${dir}/${id}.jsonl` }] : [],
  }
})

vi.mock('../../src/main/provider/codex-session-migrate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/codex-session-migrate')>()
  return { ...actual, prepareCodexProfileSwitch: vi.fn() }
})

import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { ClaudeAdapter } from '../../src/main/provider/adapters/claude-adapter'
import { ProviderChannels } from '../../src/shared/ipc-channels'
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

function liveSession(adapter: ClaudeAdapter, threadId: string): { sessionId?: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessions: Map<string, { session: { sessionId?: string } }> = (adapter as any).sessions
  const active = sessions.get(threadId)
  if (!active) throw new Error(`no active Claude session for ${threadId}`)
  return active.session
}

describe('ProviderRegistry.startSession does not clobber a resolved Claude resume id', () => {
  it('keeps the DB-resolved provider session id when the client hint is a stale sibling', async () => {
    const host = new FakeHost()
    const claude = new ClaudeAdapter()
    const registry = new ProviderRegistry(host, new Map([['claude', claude]]))
    registry.registerIpcHandlers()

    const session = await host.invoke<{ sessionId?: string }>(ProviderChannels.START_SESSION, {
      threadId: 't1',
      provider: 'claude',
      cwd: '/tmp',
      resumeSessionId: STALE_HINT,
    })

    // The value returned to the caller...
    expect(session.sessionId).toBe(STORED_ID)
    // ...and the value the adapter itself will read on the next turn's resume
    // pre-flight (sendTurn) must be the same resolved id, not the raw hint the
    // registry started with.
    expect(liveSession(claude, 't1').sessionId).toBe(STORED_ID)
  })
})
