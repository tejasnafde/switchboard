/**
 * The registry's half of merge-back: a parent's pending fork summary rides on
 * its next user turn through the real acceptance store, never on a queued
 * message, and stays pending when the provider call fails.
 */
import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import './helpers/registry-session-mocks'

const db = new Database(':memory:')
db.exec(`
  CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, pending_handoff_from TEXT, updated_at INTEGER NOT NULL);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
    tool_calls TEXT, images TEXT, timestamp INTEGER NOT NULL, display_body TEXT, pills_meta TEXT
  );
  INSERT INTO conversations VALUES ('t1', 'improvements', NULL, 1);
`)

vi.mock('../../src/main/db/provider-instances', () => ({
  resolveProviderInstance: (agentType: string, id?: string) => ({
    id: id ?? `${agentType}-default`, agentType, displayName: id ?? `${agentType}-default`, enabled: true, env: {}, oauthDir: null,
  }),
  getProviderInstanceFull: (id: string) => ({ id, agentType: 'claude-code', displayName: id, enabled: true, env: {}, oauthDir: null }),
  listOauthDirsForAgent: () => [],
}))

vi.mock('../../src/main/provider/remote-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/remote-gate')>()
  return { ...actual, remoteProviderLoginPrompt: () => null }
})

vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: () => {},
  recordConversationSegment: () => {},
  updateConversationSessionId: () => {},
  saveMessageIfAbsent: () => true,
  getConversationById: (id: string) => ({ id, title: 'improvements', archived: 0 }),
  getConversationTitle: () => null,
  resolveRootThreadId: (id: string) => id,
  getConversationRuntimeMode: () => null,
  getConversationModel: () => null,
  getConversationReasoningEffort: () => null,
  getConversationAgentType: () => null,
  getConversationProviderInstanceId: () => null,
  getSetting: () => null,
  getConversationExecutionRoot: () => null,
  commitConversationExecutionRoot: () => {},
  commitConversationProviderSwitch: () => {},
  getDb: () => db,
}))

import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import { mergeBackRowFor, parseMergeBackMarker } from '../../src/shared/merge-back'
import { ensureTurnAcceptanceSchema } from '../../src/main/db/turn-acceptance'
import { ensureMergeBackSchema, SqliteMergeBackStore } from '../../src/main/db/merge-backs'
import type { BackendHost } from '../../src/main/backend/host'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent, UserTurnSubmissionResult } from '../../src/shared/provider-events'
import type { TurnDelivery } from '../../src/shared/turn-delivery'

ensureTurnAcceptanceSchema(db)
ensureMergeBackSchema(db)

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

class RecordingAdapter implements ProviderAdapter {
  readonly provider = 'claude' as const
  sent: string[] = []
  running = false
  failNext = false
  /** Throw from the mode read that follows a successful send. */
  failAfterSend = false
  private onEvent: (e: RuntimeEvent) => void = () => {}
  async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    this.onEvent = onEvent
    return { threadId: opts.threadId, provider: this.provider, status: 'idle', runtimeMode: 'sandbox', cwd: opts.cwd, createdAt: 0 }
  }
  async sendTurn(threadId: string, text: string, _r?: unknown, _i?: unknown, delivery?: TurnDelivery, queuedId?: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('connection dropped')
    }
    this.sent.push(text)
    if (this.failAfterSend) this.modeReadFails = true
    if (delivery === 'queue' && this.running && queuedId) {
      this.onEvent({ type: 'turn.queued', threadId, messageId: queuedId })
      return
    }
    this.running = true
  }
  private modeReadFails = false
  runtimeModeOf(): 'sandbox' {
    if (this.modeReadFails) {
      this.modeReadFails = false
      this.failAfterSend = false
      throw new Error('mode read failed')
    }
    return 'sandbox'
  }
  finishTurn(threadId: string): void {
    this.running = false
    this.onEvent({ type: 'turn.completed', threadId })
  }
  async respondToRequest(): Promise<void> {}
  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async setRuntimeMode(): Promise<void> {}
  async isAvailable(): Promise<boolean> { return true }
}

let seq = 0
function seedPending(text: string): string {
  const id = `mb${++seq}`
  const store = new SqliteMergeBackStore(() => db)
  const summary = { text, turns: 1, omittedTurns: 0, files: [], moreFiles: 0, result: null, through: { at: 10 * seq, ids: [] } }
  store.createPending({ id, parentId: 't1', forkId: `fork${seq}`, row: mergeBackRowFor(id, { id: `fork${seq}`, title: 'paging' }, summary, text), through: summary.through, now: 5 })
  return id
}

function state(id: string): string | undefined {
  return new SqliteMergeBackStore(() => db).get(id)?.state
}

async function setup() {
  const host = new FakeHost()
  const adapter = new RecordingAdapter()
  const registry = new ProviderRegistry(host, new Map([['claude', adapter]]))
  registry.registerIpcHandlers()
  await host.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd: '/tmp' })
  const published: RuntimeEvent[] = []
  registry.bus.subscribe((e) => published.push(e))
  const submit = (origin: string, delivery?: TurnDelivery) => host.invoke<UserTurnSubmissionResult>(ProviderChannels.SUBMIT_USER_TURN, {
    version: 1, threadId: 't1', origin, providerText: `text of ${origin}`, ...(delivery ? { delivery } : {}),
  })
  return { host, adapter, published, submit }
}

describe('merge-back in the registry', () => {
  it('carries a pending summary on the next user turn, once, and announces the delivered row after the message', async () => {
    const t = await setup()
    const id = seedPending('the fork found a 7x win')
    expect(await t.submit('a')).toMatchObject({ status: 'accepted' })
    expect(t.adapter.sent[0]).toContain('the fork found a 7x win')
    expect(t.adapter.sent[0].endsWith('text of a')).toBe(true)
    expect(state(id)).toBe('delivered')
    const types = t.published.map((e) => e.type)
    expect(types.indexOf('merge-back.row')).toBeGreaterThan(types.indexOf('user.message'))
    const row = t.published.find((e) => e.type === 'merge-back.row')
    expect(row?.type === 'merge-back.row' && parseMergeBackMarker(row.content ?? '')?.state).toBe('delivered')

    t.adapter.finishTurn('t1')
    await t.submit('b')
    expect(t.adapter.sent[1]).toBe('text of b')
  })

  it('leaves it for a later message when the message is queued', async () => {
    const t = await setup()
    await t.submit('c')
    const id = seedPending('queued case')
    await t.submit('d', 'queue')
    expect(t.adapter.sent.at(-1)).toBe('text of d')
    expect(state(id)).toBe('pending')
    t.adapter.finishTurn('t1')
    await t.submit('e')
    expect(t.adapter.sent.at(-1)).toContain('queued case')
    expect(state(id)).toBe('delivered')
  })

  it('keeps it pending when the provider call fails', async () => {
    const t = await setup()
    const id = seedPending('failure case')
    t.adapter.failNext = true
    expect(await t.submit('f')).toMatchObject({ status: 'ambiguous' })
    expect(state(id)).toBe('pending')
    // The card can be changed again: nothing holds it.
    expect(await t.host.invoke(ProviderChannels.MERGE_BACK_EDIT, 't1', id, 'edited')).toEqual({ ok: true })
  })

  it('lets go of the summary when the turn fails after the send', async () => {
    // The previous test left its ambiguous turn unresolved, which blocks every send.
    db.prepare("DELETE FROM mobile_turn_acceptances WHERE state = 'dispatching'").run()
    const t = await setup()
    const id = seedPending('after-send failure')
    t.adapter.failAfterSend = true
    await t.host.invoke(ProviderChannels.SUBMIT_USER_TURN, {
      version: 1, threadId: 't1', origin: 'g', providerText: 'text of g', runtimeMode: 'plan',
    }).catch(() => undefined)
    expect(t.adapter.sent.at(-1)).toContain('after-send failure')
    expect(state(id)).toBe('pending')
    expect(await t.host.invoke(ProviderChannels.MERGE_BACK_DISCARD, 't1', id)).toEqual({ ok: true })
  })
})
