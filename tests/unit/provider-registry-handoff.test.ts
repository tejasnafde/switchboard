/**
 * The backend builds a pending context handoff into the next accepted turn,
 * so every client gets it (phones included) and the flag is consumed only by
 * the acceptance transaction. A provider returning to a chat it already took
 * part in, with its native session resumed, gets only what it missed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import './helpers/registry-session-mocks'

vi.mock('../../src/main/perf', () => ({ perfSpan: () => ({ end: () => {} }) }))

vi.mock('../../src/main/db/provider-instances', () => ({
  resolveProviderInstance: (agentType: string, id?: string) => ({
    id: id ?? 'work', agentType, displayName: 'Work', enabled: true, env: {}, oauthDir: null,
  }),
  getProviderInstanceFull: (id: string) => ({
    id, agentType: 'claude-code', displayName: 'Work', enabled: true, env: {}, oauthDir: null,
  }),
  listOauthDirsForAgent: () => [],
}))

vi.mock('../../src/main/provider/remote-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/remote-gate')>()
  return { ...actual, remoteProviderLoginPrompt: () => null }
})

const state = vi.hoisted(() => ({
  pending: null as string | null,
  cleared: [] as Array<[string, string]>,
  history: [] as Array<{ role: string; content: string }>,
  historyLoads: 0,
}))

vi.mock('../../src/main/conversations/history', () => ({
  loadConversationHistory: async () => {
    state.historyLoads++
    return { messages: state.history }
  },
}))

vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: () => {},
  recordConversationSegment: () => {},
  updateConversationSessionId: () => {},
  saveMessageIfAbsent: () => true,
  deleteUserMessage: () => true,
  getConversationById: (id: string) => ({ id }),
  getConversationTitle: () => null,
  resolveRootThreadId: (id: string) => id,
  getConversationRuntimeMode: () => null,
  setConversationRuntimeMode: () => {},
  getConversationModel: () => null,
  getConversationAgentType: () => null,
  getConversationProviderInstanceId: () => null,
  getConversationPendingHandoff: () => state.pending,
  clearConversationPendingHandoff: (id: string, expected: string) => { state.cleared.push([id, expected]) },
  getSetting: () => null,
  getConversationExecutionRoot: () => null,
  commitConversationExecutionRoot: () => {},
  commitConversationProviderSwitch: () => {},
  getDb: () => ({}),
}))

import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import type { BackendHost } from '../../src/main/backend/host'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent, UserTurnSubmissionV1 } from '../../src/shared/provider-events'
import type { AtomicUserTurnContext } from '../../src/main/provider/durable-turn-acceptance'

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

class FakeAdapter implements ProviderAdapter {
  readonly provider = 'claude' as const
  resumed = false
  sent: string[] = []
  startOpts: SessionStartOpts | null = null
  async startSession(opts: SessionStartOpts, _onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    this.startOpts = opts
    return { threadId: opts.threadId, provider: 'claude', status: 'idle', runtimeMode: 'sandbox', cwd: opts.cwd, createdAt: 0 }
  }
  async sendTurn(_threadId: string, message: string): Promise<void> {
    this.sent.push(message)
  }
  resumedNativeSession(): boolean {
    return this.resumed
  }
  async setRuntimeMode(): Promise<void> {}
  async respondToRequest(): Promise<void> {}
  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async isAvailable(): Promise<boolean> {
    return true
  }
}

const finalized: UserTurnSubmissionV1[] = []
const submission = {
  async submit(input: UserTurnSubmissionV1, context: AtomicUserTurnContext) {
    await context.prepare()
    const turn = context.finalize ? await context.finalize(input) : input
    finalized.push(turn)
    await context.dispatch(turn)
    return { status: 'accepted' as const, accepted: true as const, duplicate: false, state: 'completed' as const, acceptedAt: 1 }
  },
}

const marker = (from: string, to: string) => ({ role: 'system', content: `[[sb:agent-switched]] ${from} → ${to}` })

async function setup() {
  const host = new FakeHost()
  const adapter = new FakeAdapter()
  const registry = new ProviderRegistry(host, new Map([['claude', adapter]]), undefined, submission)
  registry.registerIpcHandlers()
  await host.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd: '/tmp' })
  const submit = (providerText: string) => host.invoke(ProviderChannels.SUBMIT_USER_TURN, {
    version: 1, threadId: 't1', origin: 'o1', providerText,
  })
  return { adapter, submit }
}

beforeEach(() => {
  state.pending = null
  state.cleared.length = 0
  state.historyLoads = 0
  state.history = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'claude answer' },
    marker('Claude Code', 'Codex'),
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'codex answer' },
    marker('Codex', 'Claude Code'),
  ]
  finalized.length = 0
})

describe('backend-built context handoff', () => {
  it('sends a returning agent with a resumed session only the turns it missed', async () => {
    const t = await setup()
    t.adapter.resumed = true
    state.pending = 'codex'

    await t.submit('next')

    expect(t.adapter.sent).toHaveLength(1)
    expect(t.adapter.sent[0]).toContain('user: q2\nassistant: codex answer')
    expect(t.adapter.sent[0]).not.toContain('claude answer')
    expect(t.adapter.sent[0].endsWith('\n\nnext')).toBe(true)
    expect(finalized[0]).toMatchObject({
      displayBody: 'next',
      handoff: { expectedFrom: 'codex', markerId: 'handoff_o1', markerText: '[[sb:context-handoff]] Codex → Claude Code' },
    })
  })

  it('sends the whole conversation when the native session did not resume', async () => {
    const t = await setup()
    state.pending = 'codex'
    await t.submit('next')
    expect(t.adapter.sent[0]).toContain('claude answer')
    expect(t.adapter.sent[0]).toContain('codex answer')
  })

  it('leaves a turn alone when the client already injected a preamble', async () => {
    const t = await setup()
    state.pending = 'codex'
    const injected = 'Conversation so far:\nuser: q\n\nRespond to the latest user message, using the conversation above as context.\n\nnext'
    await t.submit(injected)
    expect(t.adapter.sent).toEqual([injected])
    expect(state.historyLoads).toBe(0)
    expect(finalized[0].handoff).toBeUndefined()
  })

  it('clears the flag when there is nothing new to replay', async () => {
    const t = await setup()
    t.adapter.resumed = true
    state.pending = 'codex'
    state.history = [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, marker('Claude Code', 'Codex'), marker('Codex', 'Claude Code')]
    await t.submit('next')
    expect(t.adapter.sent).toEqual(['next'])
    expect(state.cleared).toEqual([['t1', 'codex']])
  })

  it('sends a turn untouched without a pending handoff', async () => {
    const t = await setup()
    await t.submit('plain')
    expect(t.adapter.sent).toEqual(['plain'])
    expect(state.historyLoads).toBe(0)
  })

  it('gives the adapter the visible conversation for a failed resume, minus the unanswered tail', async () => {
    const t = await setup()
    state.history = [...state.history, { role: 'user', content: 'unanswered' }]
    const preamble = await t.adapter.startOpts?.portableHistory?.()
    expect(preamble).toContain('claude answer')
    expect(preamble).toContain('codex answer')
    expect(preamble).not.toContain('unanswered')
  })
})
