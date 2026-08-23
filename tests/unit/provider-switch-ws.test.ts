/**
 * The make-or-break test for the remote refactor: provider control + event
 * streaming + mid-session model/instance switching, all driven across a real
 * WebSocket (WsTransport → WsHost → ProviderRegistry → mock adapter → host.emit
 * → back over the wire). Proves the daily plan-hopping workflow survives a
 * backend running on a VM, with no Electron and no real provider auth.
 *
 * Session metadata access is mocked. Atomic user-turn tests use a real in-memory
 * SQLite transcript and acceptance store across the transport boundary.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type AddressInfo } from 'ws'
import Database from 'better-sqlite3'

vi.mock('../../src/main/db/providerInstances', () => ({
  resolveProviderInstance: (agentType: string, id?: string) => ({
    id: id ?? `${agentType}-default`,
    agentType,
    displayName: id ?? `${agentType}-default`,
    enabled: true,
    env: {},
    oauthDir: null,
  }),
  getProviderInstanceFull: (id: string) => id === 'desktop-only' ? null : ({
    id,
    agentType: id.startsWith('codex-') ? 'codex' : id.startsWith('opencode-') ? 'opencode' : 'claude-code',
    displayName: id === 'claude-personal' ? 'Personal' : 'Work',
    enabled: true,
    env: {},
    oauthDir: null,
  }),
  listOauthDirsForAgent: () => [],
}))
vi.mock('../../src/main/provider/remote-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/remote-gate')>()
  return { ...actual, remoteProviderLoginPrompt: () => null }
})
/** Records what the registry persists, so a missing method cannot pass as a log line. */
const saved: Array<{ id: string; conversationId: string; role: string; content: string; images?: string; displayBody?: string }> = []
let allowUserTurnPersistence = true
let conversationExists = true
let resolvedRootThreadId: string | null = null
const persistedRows = new Map<string, { display_body: string | null; pills_meta?: string | null }>()
const recordedSegments: Array<{
  conversationId: string
  provider: string
  providerSessionId: string
  providerInstanceId?: string | null
}> = []
const persistedInstanceSelections: Array<{ threadId: string; instanceId: string }> = []
const profileSwitchCommits: Array<{
  conversationId: string
  provider: string
  providerInstanceId: string
  providerSessionId: string | null
  pendingHandoffFrom?: string
}> = []
const claudePreparations: Array<{ sessionId: string; cwd: string; fromDir: string; toDir: string }> = []
let claudePreparationResult: { ok: true; copied: boolean } | { ok: false; reason: string; detail: string } = {
  ok: true,
  copied: false,
}
let allowInstancePersistence = true
vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: () => {},
  recordConversationSegment: (segment: typeof recordedSegments[number]) => {
    if (!recordedSegments.some((existing) =>
      existing.conversationId === segment.conversationId &&
      existing.provider === segment.provider &&
      existing.providerSessionId === segment.providerSessionId
    )) recordedSegments.push(segment)
  },
  updateConversationSessionId: () => {},
  saveMessageIfAbsent: (id: string, conversationId: string, role: string, content: string, images?: string, displayBody?: string) => {
    if (role === 'user' && !allowUserTurnPersistence) return false
    saved.push({ id, conversationId, role, content, images, displayBody })
    return true
  },
  getMessageForConversationById: (_conversationId: string, id: string) => persistedRows.get(id),
  // Read by the session-defaults chain on every start. Null throughout, so
  // these tests keep asserting that the REQUEST wins, which is the tier they
  // exercise.
  getConversationRuntimeMode: () => null,
  getConversationModel: () => null,
  getConversationAgentType: () => null,
  getConversationProviderInstanceId: () => null,
  getConversationTitle: () => null,
  getConversationById: (id: string) => conversationExists ? { id } : undefined,
  resolveRootThreadId: (id: string) => resolvedRootThreadId ?? id,
  getSetting: () => null,
  setConversationProviderInstanceId: (threadId: string, instanceId: string) => {
    if (!allowInstancePersistence) throw new Error('database is read-only')
    persistedInstanceSelections.push({ threadId, instanceId })
  },
  commitConversationProviderSwitch: (input: typeof profileSwitchCommits[number]) => {
    if (!allowInstancePersistence) throw new Error('database is read-only')
    profileSwitchCommits.push(input)
    persistedInstanceSelections.push({ threadId: input.conversationId, instanceId: input.providerInstanceId })
    if (input.providerSessionId) {
      const segment = {
        conversationId: input.conversationId,
        provider: input.provider,
        providerSessionId: input.providerSessionId,
        providerInstanceId: input.providerInstanceId,
      }
      if (!recordedSegments.some((existing) =>
        existing.conversationId === segment.conversationId &&
        existing.provider === segment.provider &&
        existing.providerSessionId === segment.providerSessionId
      )) recordedSegments.push(segment)
    }
  },
}))
vi.mock('../../src/main/provider/claude-session-migrate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/claude-session-migrate')>()
  return {
    ...actual,
    ensureClaudeSessionResumable: () => ({ ok: true as const, sourcePath: '/tmp/source.jsonl', targetPath: '/tmp/target.jsonl' }),
    prepareClaudeProfileSwitch: (input: typeof claudePreparations[number]) => {
      claudePreparations.push(input)
      return claudePreparationResult
    },
  }
})
vi.mock('../../src/main/provider/codex-session-migrate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/codex-session-migrate')>()
  return {
    ...actual,
    prepareCodexProfileSwitch: () => ({ ok: true as const, copied: false }),
  }
})

import { WsHost } from '../../src/main/backend/ws-host'
import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { WsTransport } from '../../src/shared/ws-transport'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent } from '../../src/shared/provider-events'
import { AtomicUserTurnSubmission, DurableTurnAcceptance } from '../../src/main/provider/durable-turn-acceptance'
import { SqliteTurnAcceptanceStore, ensureTurnAcceptanceSchema } from '../../src/main/db/turn-acceptance'
import type {
  ReserveTurnResult,
  TurnAcceptanceKey,
  TurnAcceptanceState,
  TurnAcceptanceStore,
} from '../../src/main/db/turn-acceptance'

class TestTurnAcceptanceStore implements TurnAcceptanceStore {
  private readonly rows = new Map<string, { payloadHash: string; state: TurnAcceptanceState }>()
  private id(key: TurnAcceptanceKey): string {
    return `${key.clientScope}\0${key.threadId}\0${key.origin}`
  }
  reserve(key: TurnAcceptanceKey, payloadHash: string): ReserveTurnResult {
    const id = this.id(key)
    const row = this.rows.get(id)
    if (!row) {
      this.rows.set(id, { payloadHash, state: 'reserved' })
      return { kind: 'reserved', state: 'reserved' }
    }
    return row.payloadHash === payloadHash
      ? { kind: 'duplicate', state: row.state }
      : { kind: 'conflict', state: row.state }
  }
  beginDispatch(key: TurnAcceptanceKey, payloadHash: string): boolean {
    const row = this.rows.get(this.id(key))
    if (!row || row.payloadHash !== payloadHash || row.state !== 'reserved') return false
    row.state = 'dispatching'
    return true
  }
  complete(key: TurnAcceptanceKey, payloadHash: string): boolean {
    const row = this.rows.get(this.id(key))
    if (!row || row.payloadHash !== payloadHash || row.state !== 'dispatching') return false
    row.state = 'completed'
    return true
  }
  release(key: TurnAcceptanceKey, payloadHash: string): boolean {
    const id = this.id(key)
    const row = this.rows.get(id)
    if (!row || row.payloadHash !== payloadHash || row.state === 'completed') return false
    return this.rows.delete(id)
  }
}

// Echoes each turn back as a content event tagged with the current model, so a
// model switch is observable in the stream. One adapter instance, many threads.
class MockEchoAdapter implements ProviderAdapter {
  readonly provider = 'claude' as const
  protected emit = new Map<string, (e: RuntimeEvent) => void>()
  private model = new Map<string, string>()
  private turn = 0
  readonly starts: SessionStartOpts[] = []
  readonly stops: string[] = []

  async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    this.starts.push({ ...opts })
    this.emit.set(opts.threadId, onEvent)
    this.model.set(opts.threadId, opts.model ?? 'sonnet')
    return {
      threadId: opts.threadId,
      provider: 'claude',
      status: 'ready',
      model: opts.model ?? 'sonnet',
      runtimeMode: opts.runtimeMode ?? 'sandbox',
      cwd: opts.cwd,
      createdAt: 0,
    }
  }

  async sendTurn(threadId: string, message: string): Promise<void> {
    const onEvent = this.emit.get(threadId)
    if (!onEvent) return
    onEvent({
      type: 'content',
      threadId,
      messageId: `m${++this.turn}`,
      text: `[${this.model.get(threadId)}] echo: ${message}`,
      streamKind: 'assistant',
    })
    onEvent({ type: 'turn.completed', threadId })
  }

  async setModel(threadId: string, model: string): Promise<void> {
    this.model.set(threadId, model)
  }

  async interruptTurn(): Promise<void> {}
  async respondToRequest(): Promise<void> {}
  async stopSession(threadId: string): Promise<void> {
    this.stops.push(threadId)
    this.emit.delete(threadId)
    this.model.delete(threadId)
  }
  async setRuntimeMode(): Promise<void> {}
  async isAvailable(): Promise<boolean> {
    return true
  }

  publishStatus(threadId: string, status: 'idle' | 'running'): void {
    this.emit.get(threadId)?.({ type: 'status', threadId, status })
  }
}

class MissingLocalSessionOnceAdapter extends MockEchoAdapter {
  attempts = 0

  override async sendTurn(threadId: string, message: string): Promise<void> {
    this.attempts += 1
    if (this.attempts === 1) throw new Error(`Session ${threadId} not found`)
    await super.sendTurn(threadId, message)
  }
}

class FailingTargetAdapter extends MockEchoAdapter {
  override async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    if (opts.instanceId === 'claude-personal') {
      this.starts.push({ ...opts })
      throw new Error('target auth failed')
    }
    return super.startSession(opts, onEvent)
  }
}

class DeferredStartAdapter extends MockEchoAdapter {
  private releaseStart!: () => void
  readonly startEntered = new Promise<void>((resolve) => {
    this.releaseStart = resolve
  })
  private continueStart!: () => void
  private readonly startGate = new Promise<void>((resolve) => {
    this.continueStart = resolve
  })

  override async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    this.releaseStart()
    await this.startGate
    return super.startSession(opts, onEvent)
  }

  finishStart(): void {
    this.continueStart()
  }
}

class DeferredStopAdapter extends MockEchoAdapter {
  private markStopEntered!: () => void
  readonly stopEntered = new Promise<void>((resolve) => {
    this.markStopEntered = resolve
  })
  private continueStop!: () => void
  private readonly stopGate = new Promise<void>((resolve) => {
    this.continueStop = resolve
  })

  override async stopSession(threadId: string): Promise<void> {
    this.markStopEntered()
    await this.stopGate
    await super.stopSession(threadId)
  }

  finishStop(): void {
    this.continueStop()
  }
}

class StopRotatingSessionAdapter extends MockEchoAdapter {
  override async startSession(opts: SessionStartOpts, onEvent: (event: RuntimeEvent) => void): Promise<ProviderSession> {
    const session = await super.startSession(opts, onEvent)
    onEvent({ type: 'session', threadId: opts.threadId, sessionId: 'provider-session-1' })
    return session
  }

  override async stopSession(threadId: string): Promise<void> {
    this.emit.get(threadId)?.({ type: 'session', threadId, sessionId: 'provider-session-during-stop' })
    await super.stopSession(threadId)
  }
}

class RetainedCallbackAdapter extends MockEchoAdapter {
  private firstCallback: ((event: RuntimeEvent) => void) | null = null

  override async startSession(opts: SessionStartOpts, onEvent: (event: RuntimeEvent) => void): Promise<ProviderSession> {
    if (!this.firstCallback) this.firstCallback = onEvent
    const session = await super.startSession(opts, onEvent)
    onEvent({ type: 'session', threadId: opts.threadId, sessionId: 'provider-session-1' })
    return session
  }

  publishFromRetiredExecution(threadId: string): void {
    this.firstCallback?.({
      type: 'content',
      threadId,
      messageId: 'retired-content',
      text: 'stale source output',
      streamKind: 'assistant',
    })
  }
}

class SessionPublishingAdapter extends MockEchoAdapter {
  override async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    const session = await super.startSession(opts, onEvent)
    onEvent({ type: 'session', threadId: opts.threadId, sessionId: 'provider-session-1' })
    return session
  }

  publishSession(threadId: string, sessionId: string): void {
    this.emit.get(threadId)?.({ type: 'session', threadId, sessionId })
  }
}

class RotatingSessionAdapter extends MockEchoAdapter {
  private sequence = 0

  override async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    const session = await super.startSession(opts, onEvent)
    onEvent({
      type: 'session',
      threadId: opts.threadId,
      sessionId: `${opts.instanceId ?? 'default'}-session-${++this.sequence}`,
    })
    return session
  }
}

class QueueingAdapter extends MockEchoAdapter {
  override async sendTurn(): Promise<void> {}

  complete(threadId: string): void {
    this.emit.get(threadId)?.({ type: 'turn.completed', threadId })
  }
}

class CodexSteeringAdapter implements ProviderAdapter {
  readonly provider = 'codex' as const
  protected emit = new Map<string, (event: RuntimeEvent) => void>()

  async startSession(opts: SessionStartOpts, onEvent: (event: RuntimeEvent) => void): Promise<ProviderSession> {
    this.emit.set(opts.threadId, onEvent)
    return {
      threadId: opts.threadId,
      provider: 'codex',
      status: 'ready',
      runtimeMode: opts.runtimeMode ?? 'sandbox',
      cwd: opts.cwd,
      createdAt: 0,
    }
  }

  async sendTurn(): Promise<void> {}
  async interruptTurn(): Promise<void> {}
  async respondToRequest(): Promise<void> {}
  async stopSession(threadId: string): Promise<void> { this.emit.delete(threadId) }
  async setRuntimeMode(): Promise<void> {}
  async isAvailable(): Promise<boolean> { return true }

  complete(threadId: string): void {
    this.emit.get(threadId)?.({ type: 'turn.completed', threadId })
  }
}

class FailingTargetAndRollbackAdapter extends MockEchoAdapter {
  private workStarts = 0

  override async startSession(opts: SessionStartOpts, onEvent: (event: RuntimeEvent) => void): Promise<ProviderSession> {
    if (opts.instanceId === 'claude-work') this.workStarts += 1
    if (opts.instanceId === 'claude-personal' || this.workStarts > 1) {
      this.starts.push({ ...opts })
      throw new Error(`cannot start ${opts.instanceId}`)
    }
    return super.startSession(opts, onEvent)
  }
}

class ThrowingStopAdapter extends MockEchoAdapter {
  override async stopSession(): Promise<void> {
    throw new Error('provider refused to stop')
  }
}

class BusyOpenCodeAdapter implements ProviderAdapter {
  readonly provider = 'opencode' as const
  sendCount = 0

  async startSession(opts: SessionStartOpts): Promise<ProviderSession> {
    return {
      threadId: opts.threadId,
      provider: 'opencode',
      status: 'ready',
      runtimeMode: opts.runtimeMode ?? 'sandbox',
      cwd: opts.cwd,
      createdAt: 0,
    }
  }

  async sendTurn(): Promise<void> {
    this.sendCount += 1
  }

  async interruptTurn(): Promise<void> {}
  async respondToRequest(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async setRuntimeMode(): Promise<void> {}
  async isAvailable(): Promise<boolean> { return true }
}

let wss: WebSocketServer | null = null
let client: WsTransport | null = null
let registry: ProviderRegistry | null = null
let atomicDb: Database.Database | null = null
/** Scratch cwds this file created, removed in afterEach so repeated runs do not
 *  pile up dirs under TMPDIR. */
const scratchDirs: string[] = []

async function setup(
  adapter: ProviderAdapter = new MockEchoAdapter(),
  providerKey: 'claude' | 'codex' | 'opencode' = 'claude',
  atomicSubmission?: {
    submit(input: unknown, context: { clientScope: string; prepare: () => Promise<void>; dispatch: () => Promise<void> }): Promise<unknown>
  },
) {
  const cwd = mkdtempSync(join(tmpdir(), 'sb-prov-'))
  scratchDirs.push(cwd)
  wss = new WebSocketServer({ port: 0 })
  const host = new WsHost(wss)
  let effectiveAtomicSubmission = atomicSubmission
  if (!effectiveAtomicSubmission) {
    atomicDb = new Database(':memory:')
    atomicDb.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        pending_handoff_from TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        images TEXT,
        timestamp INTEGER NOT NULL,
        display_body TEXT,
        pills_meta TEXT
      );
      INSERT INTO conversations VALUES ('t1', 'New conversation', NULL, 1);
    `)
    ensureTurnAcceptanceSchema(atomicDb)
    effectiveAtomicSubmission = new AtomicUserTurnSubmission({
      store: new SqliteTurnAcceptanceStore(() => atomicDb!),
      publish: (event) => host.emit(ProviderChannels.EVENT, event),
    })
  }
  const RegistryWithAtomic = ProviderRegistry as unknown as new (
    host: WsHost,
    adapters: Map<'claude' | 'codex' | 'opencode', ProviderAdapter>,
    acceptance: DurableTurnAcceptance,
    atomicSubmission?: typeof atomicSubmission,
  ) => ProviderRegistry
  registry = new RegistryWithAtomic(
    host,
    new Map([[providerKey, adapter]]),
    new DurableTurnAcceptance(new TestTurnAcceptanceStore()),
    effectiveAtomicSubmission,
  )
  registry.registerIpcHandlers()
  await new Promise<void>((res) => wss!.on('listening', () => res()))
  const { port } = wss.address() as AddressInfo

  const events: RuntimeEvent[] = []
  client = new WsTransport(`ws://localhost:${port}`)
  client.on(ProviderChannels.EVENT, (e: RuntimeEvent) => events.push(e))
  return { cwd, events, atomicDb }
}

const flush = () => new Promise((r) => setTimeout(r, 40))

afterEach(async () => {
  allowUserTurnPersistence = true
  conversationExists = true
  resolvedRootThreadId = null
  allowInstancePersistence = true
  persistedInstanceSelections.length = 0
  profileSwitchCommits.length = 0
  claudePreparations.length = 0
  claudePreparationResult = { ok: true, copied: false }
  client?.close()
  client = null
  await registry?.stopAll()
  registry = null
  atomicDb?.close()
  atomicDb = null
  await new Promise<void>((res) => (wss ? wss.close(() => res()) : res()))
  wss = null
  while (scratchDirs.length) rmSync(scratchDirs.pop()!, { recursive: true, force: true })
})

describe('provider switching over the WebSocket boundary', () => {
  it('records typed provider lineage when an adapter assigns a native session id', async () => {
    recordedSegments.length = 0
    const { cwd } = await setup(new SessionPublishingAdapter())

    await client!.invoke(ProviderChannels.START_SESSION, {
      threadId: 't1',
      provider: 'claude',
      cwd,
      instanceId: 'claude-work',
    })

    expect(recordedSegments).toEqual([{
      conversationId: 't1',
      provider: 'claude-code',
      providerSessionId: 'provider-session-1',
      providerInstanceId: 'claude-work',
    }])
  })

  it('waits for an in-flight provider start before accepting a rapid follow-up', async () => {
    const adapter = new DeferredStartAdapter()
    const { cwd } = await setup(adapter)

    const start = client!.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd })
    await adapter.startEntered
    const send = client!.invoke(ProviderChannels.SEND_TURN, 't1', 'attached image').then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    await flush()

    adapter.finishStart()
    await expect(start).resolves.toMatchObject({ threadId: 't1' })
    await expect(send).resolves.toEqual({ ok: true })
  })

  it('re-attaches with the live status after startup has completed', async () => {
    const adapter = new MockEchoAdapter()
    const { cwd } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd })
    adapter.publishStatus('t1', 'running')

    const session = await client!.invoke<ProviderSession>(
      ProviderChannels.START_SESSION,
      { threadId: 't1', provider: 'claude', cwd },
    )

    expect(session.status).toBe('running')
  })

  it('is-available, start, send, and event streaming all traverse the wire', async () => {
    const { cwd, events } = await setup()

    expect(await client!.invoke(ProviderChannels.IS_AVAILABLE, 'claude')).toBe(true)

    const session = await client!.invoke<{ threadId: string; instanceId?: string }>(
      ProviderChannels.START_SESSION,
      { threadId: 't1', provider: 'claude', cwd, instanceId: 'claude-work' },
    )
    expect(session.threadId).toBe('t1')
    expect(session.instanceId).toBe('claude-work')

    await client!.invoke(ProviderChannels.SEND_TURN, 't1', 'hello')
    await flush()

    const content = events.find((e) => e.type === 'content')
    expect(content && 'text' in content ? content.text : '').toBe('[sonnet] echo: hello')
    expect(events.some((e) => e.type === 'turn.completed')).toBe(true)
  })

  it('submits a typed atomic user-turn envelope across the real transport', async () => {
    const adapter = new MockEchoAdapter()
    const seen: unknown[] = []
    const atomicSubmission = {
      submit: async (input: unknown, context: { clientScope: string; prepare: () => Promise<void>; dispatch: () => Promise<void> }) => {
        seen.push(input)
        await context.prepare()
        await context.dispatch()
        return {
          status: 'accepted', accepted: true, duplicate: false, state: 'completed', acceptedAt: 100,
        }
      },
    }
    const { cwd, events } = await setup(adapter, 'claude', atomicSubmission)
    await client!.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd })
    const envelope = {
      version: 1,
      threadId: 't1',
      origin: 'desktop-atomic-1',
      providerText: 'expanded provider text',
      displayBody: '[[pill:file-1]] explain this',
      pillsMeta: { 'file-1': { label: 'src/main.ts', kind: 'file' } },
      images: [{ url: 'data:image/png;base64,AAAA', mimeType: 'image/png', name: 'one.png' }],
      runtimeMode: 'sandbox',
    }

    await expect(client!.invoke(ProviderChannels.SUBMIT_USER_TURN, envelope)).resolves.toMatchObject({
      status: 'accepted',
    })
    expect(seen).toEqual([envelope])
    await flush()
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
  })

  it('definitely rejects before dispatch when the conversation row is missing', async () => {
    const adapter = new MockEchoAdapter()
    const { cwd, atomicDb } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd })
    conversationExists = false

    await expect(client!.invoke(ProviderChannels.SUBMIT_USER_TURN, {
      version: 1,
      threadId: 't1',
      origin: 'missing-conversation',
      providerText: 'must not dispatch',
    })).resolves.toMatchObject({ status: 'rejected', state: 'rejected' })
    expect(atomicDb!.prepare('SELECT count(*) AS count FROM mobile_turn_acceptances').get())
      .toEqual({ count: 0 })
    expect(atomicDb!.prepare('SELECT count(*) AS count FROM messages').get())
      .toEqual({ count: 0 })
  })

  it('releases a local adapter precondition failure so the same origin can retry', async () => {
    const adapter = new MissingLocalSessionOnceAdapter()
    const { cwd, atomicDb } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd })
    const turn = {
      version: 1,
      threadId: 't1',
      origin: 'local-session-race',
      providerText: 'retry me exactly',
    }

    await expect(client!.invoke(ProviderChannels.SUBMIT_USER_TURN, turn))
      .resolves.toMatchObject({ status: 'rejected' })
    expect(atomicDb!.prepare('SELECT count(*) AS count FROM mobile_turn_acceptances').get())
      .toEqual({ count: 0 })
    await expect(client!.invoke(ProviderChannels.SUBMIT_USER_TURN, turn))
      .resolves.toMatchObject({ status: 'accepted' })
    expect(adapter.attempts).toBe(2)
  })

  it('commits a rotated provider id against its root conversation', async () => {
    resolvedRootThreadId = 't1'
    const { cwd, atomicDb, events } = await setup()
    await client!.invoke(ProviderChannels.START_SESSION, {
      threadId: 'provider-leaf', provider: 'claude', cwd,
    })

    await expect(client!.invoke(ProviderChannels.SUBMIT_USER_TURN, {
      version: 1,
      threadId: 'provider-leaf',
      origin: 'rotated-origin',
      providerText: 'continue after rotation',
    })).resolves.toMatchObject({ status: 'accepted' })
    await flush()

    expect(atomicDb!.prepare("SELECT conversation_id FROM messages WHERE role = 'user'").get())
      .toEqual({ conversation_id: 't1' })
    expect(events.find((event) => event.type === 'user.message')).toMatchObject({ threadId: 't1' })
  })

  // The renderer was the only writer of `messages`, so a turn sent from the
  // phone left no row at all: no search hit, no DB fallback, and `updated_at`
  // never moved so the chat stayed buried in the phone's own sort.
  it('persists a turn sent by a client that is not the desktop renderer', async () => {
    const { cwd, atomicDb } = await setup()
    await client!.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd })
    const accepted = await client!.invoke(
      ProviderChannels.SEND_TURN, 't1', 'from the phone', undefined, undefined, 'o-1',
    )
    await flush()

    const turn = atomicDb!.prepare(`
      SELECT id, conversation_id AS conversationId, role, content
        FROM messages
       WHERE role = 'user'
    `).get() as typeof saved[number] | undefined
    expect(turn).toBeDefined()
    expect(turn?.content).toBe('from the phone')
    expect(turn?.conversationId).toBe('t1')
    // echoMessageId(origin) - the id the optimistic bubble already uses, so the
    // renderer's own richer write targets this row instead of adding a second.
    expect(turn?.id).toBe('remote_o-1')
    expect(atomicDb!.prepare("SELECT title FROM conversations WHERE id = 't1'").get())
      .toEqual({ title: 'from the phone' })
    expect(accepted).toEqual({ accepted: true, duplicate: false, state: 'completed' })
  })

  it('keeps a post-dispatch transcript commit failure ambiguous', async () => {
    const adapter = new MockEchoAdapter()
    const { cwd, events, atomicDb } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd })
    atomicDb!.exec(`
      CREATE TRIGGER reject_user_transcript
      BEFORE INSERT ON messages
      WHEN NEW.role = 'user'
      BEGIN
        SELECT RAISE(ABORT, 'transcript unavailable');
      END;
    `)

    await expect(client!.invoke(
      ProviderChannels.SEND_TURN,
      't1',
      'must survive a restart',
      undefined,
      [{ url: 'data:image/png;base64,AAA', mimeType: 'image/png' }],
      'durable-origin',
    )).resolves.toMatchObject({ accepted: false, state: 'ambiguous' })

    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
    expect(events.some((event) => event.type === 'user.message')).toBe(false)
    expect(adapter.starts).toHaveLength(1)
    expect(atomicDb!.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'user'").get())
      .toEqual({ count: 0 })
    expect(atomicDb!.prepare(`
      SELECT state FROM mobile_turn_acceptances WHERE origin = 'durable-origin'
    `).get()).toEqual({ state: 'dispatching' })
  })

  it('broadcasts images and available persisted pill presentation with the user echo', async () => {
    const { cwd, events, atomicDb } = await setup()
    atomicDb!.prepare(`
      INSERT INTO messages
        (id, conversation_id, role, content, timestamp, display_body, pills_meta)
      VALUES (?, 't1', 'user', ?, 1, ?, ?)
    `).run(
      'remote_o-image',
      'context wrapper\n\nshow this',
      '[[pill:selection-1]] show this',
      JSON.stringify({
        'selection-1': { label: 'Admin panel', kind: 'chat-message' },
      }),
    )
    await client!.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd })
    const images = [{ url: 'data:image/png;base64,AAA', mimeType: 'image/png' }]
    await client!.invoke(
      ProviderChannels.SEND_TURN, 't1', 'context wrapper\n\nshow this', undefined, images, 'o-image',
    )
    await flush()

    expect(events.find((event) => event.type === 'user.message')).toMatchObject({
      type: 'user.message',
      text: 'context wrapper\n\nshow this',
      displayBody: '[[pill:selection-1]] show this',
      pillsMeta: {
        'selection-1': { label: 'Admin panel', kind: 'chat-message' },
      },
      images,
      origin: 'o-image',
    })
  })

  it('does not broadcast corrupt persisted pill metadata', async () => {
    const { cwd, events, atomicDb } = await setup()
    atomicDb!.prepare(`
      INSERT INTO messages
        (id, conversation_id, role, content, timestamp, display_body, pills_meta)
      VALUES ('remote_o-corrupt-pill', 't1', 'user', 'expanded content', 1,
              'show [[pill:private]]', '{not-json')
    `).run()
    await client!.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd })
    await client!.invoke(
      ProviderChannels.SEND_TURN, 't1', 'expanded content', undefined, undefined, 'o-corrupt-pill',
    )

    expect(events.find((event) => event.type === 'user.message')).toMatchObject({
      type: 'user.message',
      displayBody: 'show [[pill:private]]',
    })
    expect(events.find((event) => event.type === 'user.message')).not.toHaveProperty('pillsMeta')
  })

  it('answers a completed origin retry as domain success without dispatching again', async () => {
    const adapter = new MockEchoAdapter()
    const { cwd, events } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd })

    const first = await client!.invoke(
      ProviderChannels.SEND_TURN, 't1', 'once', undefined, undefined, 'origin-once',
    )
    const retry = await client!.invoke(
      ProviderChannels.SEND_TURN, 't1', 'once', undefined, undefined, 'origin-once',
    )

    expect(first).toEqual({ accepted: true, duplicate: false, state: 'completed' })
    expect(retry).toEqual({ accepted: true, duplicate: true, state: 'completed' })
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'user.message')).toHaveLength(2)
  })

  it('definitely rejects a second OpenCode prompt while its first turn is active', async () => {
    const adapter = new BusyOpenCodeAdapter()
    const { cwd, events, atomicDb } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd })

    await expect(client!.invoke(
      ProviderChannels.SEND_TURN, 't1', 'first', undefined, undefined, 'opencode-first',
    )).resolves.toMatchObject({ accepted: true })
    await expect(client!.invoke(
      ProviderChannels.SEND_TURN, 't1', 'second', undefined, undefined, 'opencode-second',
    )).rejects.toThrow('mid-turn')

    expect(adapter.sendCount).toBe(1)
    expect(events.filter((event) => event.type === 'user.message')).toHaveLength(1)
    expect(atomicDb!.prepare("SELECT COUNT(*) AS count FROM messages WHERE content = 'second'").get())
      .toEqual({ count: 0 })
  })

  it('does not persist a legacy-origin row when checkpoint preparation rejects', async () => {
    const { cwd, events, atomicDb } = await setup()
    await client!.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd })
    Reflect.set(registry!, 'checkpoints', {
      beginTurn: async () => { throw new Error('checkpoint failed') },
      finishTurn: async () => [],
      clear: () => {},
    })

    await expect(client!.invoke(
      ProviderChannels.SEND_TURN, 't1', 'must not look sent', undefined, undefined, 'legacy-rejected',
    )).rejects.toThrow('turn preparation failed')

    expect(atomicDb!.prepare("SELECT COUNT(*) AS count FROM messages WHERE content = 'must not look sent'").get())
      .toEqual({ count: 0 })
    expect(atomicDb!.prepare("SELECT COUNT(*) AS count FROM mobile_turn_acceptances WHERE origin = 'legacy-rejected'").get())
      .toEqual({ count: 0 })
    expect(events.some((event) => event.type === 'user.message')).toBe(false)
  })

  it('persists a turn even when the client sends no origin (the phone\'s first message)', async () => {
    const { cwd } = await setup()
    saved.length = 0
    await client!.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd })
    await client!.invoke(ProviderChannels.SEND_TURN, 't1', 'opening turn')
    await flush()

    const turn = saved.find((m) => m.role === 'user')
    expect(turn?.content).toBe('opening turn')
    expect(turn?.id).toMatch(/^turn_\d+_\d+$/)
  })

  it('a mid-session model switch takes effect across the wire', async () => {
    const { cwd, events } = await setup()
    await client!.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd })

    await client!.invoke(ProviderChannels.SET_MODEL, 't1', 'opus')
    await client!.invoke(ProviderChannels.SEND_TURN, 't1', 'after switch')
    await flush()

    const texts = events.filter((e) => e.type === 'content').map((e) => ('text' in e ? e.text : ''))
    expect(texts).toContain('[opus] echo: after switch')
  })

  it('separate sessions resolve to the instance each requested', async () => {
    const { cwd } = await setup()
    const work = await client!.invoke<{ instanceId?: string }>(
      ProviderChannels.START_SESSION,
      { threadId: 'work', provider: 'claude', cwd, instanceId: 'claude-work' },
    )
    const personal = await client!.invoke<{ instanceId?: string }>(
      ProviderChannels.START_SESSION,
      { threadId: 'personal', provider: 'claude', cwd, instanceId: 'claude-personal' },
    )
    expect(work.instanceId).toBe('claude-work')
    expect(personal.instanceId).toBe('claude-personal')
  })

  it('atomically switches an idle thread profile and publishes one committed identity', async () => {
    const adapter = new MockEchoAdapter()
    const { cwd, events } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, {
      threadId: 't1', provider: 'claude', cwd, instanceId: 'claude-work',
    })
    events.length = 0

    const result = await client!.invoke(ProviderChannels.SWITCH_INSTANCE, 't1', {
      targetInstanceId: 'claude-personal',
      expectedCurrentInstanceId: 'claude-work',
    })

    expect(result).toMatchObject({
      ok: true,
      previousInstanceId: 'claude-work',
      instanceId: 'claude-personal',
      instanceName: 'Personal',
    })
    expect(persistedInstanceSelections).toEqual([{ threadId: 't1', instanceId: 'claude-personal' }])
    expect(adapter.stops).toEqual(['t1'])
    expect(adapter.starts.map((start) => start.instanceId)).toEqual(['claude-work', 'claude-personal'])
    expect(adapter.starts[1]?.resumeSessionId).toBeUndefined()
    expect(events.filter((event) => event.type === 'session.provider')).toEqual([
      expect.objectContaining({ instanceId: 'claude-personal', instanceName: 'Personal' }),
    ])
  })

  it('keeps a desktop-routed remote profile identity and config directory', async () => {
    const adapter = new MockEchoAdapter()
    const { cwd } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, {
      threadId: 't1', provider: 'claude', cwd, instanceId: 'claude-work',
    })
    const previousRemote = process.env.SWITCHBOARD_REMOTE
    process.env.SWITCHBOARD_REMOTE = '1'
    try {
      await expect(client!.invoke(ProviderChannels.SWITCH_INSTANCE, 't1', {
        targetInstanceId: 'desktop-only',
        targetInstanceName: 'Tech Team',
        targetRemoteConfigDir: '.claude-tech-team',
        expectedCurrentInstanceId: 'claude-work',
      })).resolves.toMatchObject({
        ok: true,
        instanceId: 'desktop-only',
        instanceName: 'Tech Team',
      })
      expect(adapter.starts[1]).toMatchObject({
        instanceId: 'desktop-only',
        remoteConfigDir: '.claude-tech-team',
        resolvedOauthDir: expect.stringMatching(/\.claude-tech-team$/),
      })

      await expect(client!.invoke(ProviderChannels.SWITCH_INSTANCE, 't1', {
        targetInstanceId: 'claude-work',
        targetInstanceName: 'Work',
        targetRemoteConfigDir: '.claude-work',
        expectedCurrentInstanceId: 'desktop-only',
      })).resolves.toMatchObject({ ok: true, previousInstanceId: 'desktop-only' })
    } finally {
      if (previousRemote === undefined) delete process.env.SWITCHBOARD_REMOTE
      else process.env.SWITCHBOARD_REMOTE = previousRemote
    }
  })

  it('resumes the latest provider session after the provider rotates its session id', async () => {
    const adapter = new SessionPublishingAdapter()
    const { cwd } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, {
      threadId: 't1', provider: 'claude', cwd, instanceId: 'claude-work',
    })
    adapter.publishSession('t1', 'provider-session-after-compaction')

    await expect(client!.invoke(ProviderChannels.SWITCH_INSTANCE, 't1', {
      targetInstanceId: 'claude-personal', expectedCurrentInstanceId: 'claude-work',
    })).resolves.toMatchObject({ ok: true, continuity: 'preserved' })

    expect(adapter.starts[1]?.resumeSessionId).toBe('provider-session-after-compaction')
  })

  it('stops and drains before preparing the final source transcript', async () => {
    const adapter = new StopRotatingSessionAdapter()
    const { cwd } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, {
      threadId: 't1', provider: 'claude', cwd, instanceId: 'claude-work',
    })

    await expect(client!.invoke(ProviderChannels.SWITCH_INSTANCE, 't1', {
      targetInstanceId: 'claude-personal', expectedCurrentInstanceId: 'claude-work',
    })).resolves.toMatchObject({ ok: true, continuity: 'preserved' })

    expect(claudePreparations).toHaveLength(1)
    expect(claudePreparations[0]).toMatchObject({
      sessionId: 'provider-session-during-stop',
      cwd,
    })
    expect(adapter.starts[1]?.resumeSessionId).toBe('provider-session-during-stop')
  })

  it('rolls back to the source without starting the target when transcripts diverge', async () => {
    claudePreparationResult = {
      ok: false,
      reason: 'context-conflict',
      detail: 'Both profiles contain different records',
    }
    const adapter = new SessionPublishingAdapter()
    const { cwd } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, {
      threadId: 't1', provider: 'claude', cwd, instanceId: 'claude-work',
    })

    await expect(client!.invoke(ProviderChannels.SWITCH_INSTANCE, 't1', {
      targetInstanceId: 'claude-personal', expectedCurrentInstanceId: 'claude-work',
    })).resolves.toMatchObject({
      ok: false,
      code: 'context-conflict',
      rolledBack: true,
      currentInstanceId: 'claude-work',
    })
    expect(adapter.starts.map((start) => start.instanceId)).toEqual(['claude-work', 'claude-work'])
    expect(persistedInstanceSelections).toEqual([])
  })

  it('does not expose a rolled-back preparation failure as a DB-only initial selection', async () => {
    claudePreparationResult = {
      ok: false,
      reason: 'source-missing',
      detail: 'The active profile transcript disappeared',
    }
    const adapter = new SessionPublishingAdapter()
    const { cwd } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, {
      threadId: 't1', provider: 'claude', cwd, instanceId: 'claude-work',
    })

    await expect(client!.invoke(ProviderChannels.SWITCH_INSTANCE, 't1', {
      targetInstanceId: 'claude-personal', expectedCurrentInstanceId: 'claude-work',
    })).resolves.toMatchObject({
      ok: false,
      code: 'context-preparation-failed',
      rolledBack: true,
      currentInstanceId: 'claude-work',
    })
    expect(adapter.starts.map((start) => start.instanceId)).toEqual(['claude-work', 'claude-work'])
    expect(persistedInstanceSelections).toEqual([])
  })

  it('starts a fresh target only after explicit conflict recovery', async () => {
    claudePreparationResult = {
      ok: false,
      reason: 'context-conflict',
      detail: 'Both profiles contain different records',
    }
    const adapter = new SessionPublishingAdapter()
    const { cwd } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, {
      threadId: 't1', provider: 'claude', cwd, instanceId: 'claude-work',
    })

    await expect(client!.invoke(ProviderChannels.SWITCH_INSTANCE, 't1', {
      targetInstanceId: 'claude-personal',
      expectedCurrentInstanceId: 'claude-work',
      onContextConflict: 'start-fresh',
    })).resolves.toMatchObject({ ok: true, continuity: 'degraded' })

    expect(claudePreparations).toEqual([])
    expect(adapter.starts[1]).toMatchObject({ instanceId: 'claude-personal' })
    expect(adapter.starts[1]?.resumeSessionId).toBeUndefined()
    expect(profileSwitchCommits.at(-1)).toMatchObject({
      providerInstanceId: 'claude-personal',
      pendingHandoffFrom: 'claude-code',
    })
  })

  it('drops events from the retired source execution after the target commits', async () => {
    const adapter = new RetainedCallbackAdapter()
    const { cwd, events } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, {
      threadId: 't1', provider: 'claude', cwd, instanceId: 'claude-work',
    })
    events.length = 0

    await client!.invoke(ProviderChannels.SWITCH_INSTANCE, 't1', {
      targetInstanceId: 'claude-personal', expectedCurrentInstanceId: 'claude-work',
    })
    adapter.publishFromRetiredExecution('t1')
    await flush()

    expect(events).not.toContainEqual(expect.objectContaining({ messageId: 'retired-content' }))
  })

  it('rejects a busy or stale profile switch without stopping the live session', async () => {
    const adapter = new MockEchoAdapter()
    const { cwd } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, {
      threadId: 't1', provider: 'claude', cwd, instanceId: 'claude-work',
    })
    adapter.publishStatus('t1', 'running')

    await expect(client!.invoke(ProviderChannels.SWITCH_INSTANCE, 't1', {
      targetInstanceId: 'claude-personal', expectedCurrentInstanceId: 'claude-work',
    })).resolves.toMatchObject({ ok: false, code: 'busy' })
    expect(adapter.stops).toEqual([])

    adapter.publishStatus('t1', 'idle')
    await expect(client!.invoke(ProviderChannels.SWITCH_INSTANCE, 't1', {
      targetInstanceId: 'claude-personal', expectedCurrentInstanceId: 'claude-stale',
    })).resolves.toMatchObject({ ok: false, code: 'stale-selection' })
    expect(adapter.stops).toEqual([])
  })

  it('keeps a turn retryable while an idle session is changing profiles', async () => {
    const adapter = new DeferredStopAdapter()
    const { cwd } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, {
      threadId: 't1', provider: 'claude', cwd, instanceId: 'claude-work',
    })

    const switching = client!.invoke(ProviderChannels.SWITCH_INSTANCE, 't1', {
      targetInstanceId: 'claude-personal', expectedCurrentInstanceId: 'claude-work',
    })
    await adapter.stopEntered

    await expect(client!.invoke(
      ProviderChannels.SEND_TURN,
      't1',
      'wait for the switch',
      'sandbox',
      undefined,
      'phone-turn-1',
    )).rejects.toThrow(/queue full.*profile switch/i)

    adapter.finishStop()
    await expect(switching).resolves.toMatchObject({ ok: true, instanceId: 'claude-personal' })
    expect(saved.some((message) => message.content === 'wait for the switch')).toBe(false)
  })

  it('does not switch while a peer delivery is preparing its checkpoint', async () => {
    const adapter = new MockEchoAdapter()
    const { cwd } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, {
      threadId: 't1', provider: 'claude', cwd, instanceId: 'claude-work',
    })
    let markCheckpointEntered!: () => void
    const checkpointEntered = new Promise<void>((resolve) => { markCheckpointEntered = resolve })
    let continueCheckpoint!: () => void
    const checkpointGate = new Promise<void>((resolve) => { continueCheckpoint = resolve })
    Reflect.set(registry!, 'checkpoints', {
      beginTurn: async () => {
        markCheckpointEntered()
        await checkpointGate
      },
      finishTurn: async () => [],
      clear: () => {},
    })

    const delivery = registry!.deliverPeerMessage({
      fromThreadId: 'sender',
      targetThreadId: 't1',
      text: 'peer handoff',
      initiator: 'user',
    })
    await checkpointEntered
    await expect(client!.invoke(ProviderChannels.SWITCH_INSTANCE, 't1', {
      targetInstanceId: 'claude-personal', expectedCurrentInstanceId: 'claude-work',
    })).resolves.toMatchObject({ ok: false, code: 'busy' })

    continueCheckpoint()
    await expect(delivery).resolves.toMatchObject({ id: expect.any(String) })
    expect(adapter.stops).toEqual([])
  })

  it('does not switch while a second accepted Claude prompt remains queued', async () => {
    const adapter = new QueueingAdapter()
    const { cwd } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, {
      threadId: 't1', provider: 'claude', cwd, instanceId: 'claude-work',
    })
    await client!.invoke(ProviderChannels.SEND_TURN, 't1', 'first')
    await client!.invoke(ProviderChannels.SEND_TURN, 't1', 'second')

    adapter.complete('t1')
    await expect(client!.invoke(ProviderChannels.SWITCH_INSTANCE, 't1', {
      targetInstanceId: 'claude-personal', expectedCurrentInstanceId: 'claude-work',
    })).resolves.toMatchObject({ ok: false, code: 'busy' })

    adapter.complete('t1')
    await expect(client!.invoke(ProviderChannels.SWITCH_INSTANCE, 't1', {
      targetInstanceId: 'claude-personal', expectedCurrentInstanceId: 'claude-work',
    })).resolves.toMatchObject({ ok: true, instanceId: 'claude-personal' })
  })

  it('does not count a Codex steer as a second provider turn', async () => {
    const adapter = new CodexSteeringAdapter()
    const { cwd } = await setup(adapter, 'codex')
    await client!.invoke(ProviderChannels.START_SESSION, {
      threadId: 't1', provider: 'codex', cwd, instanceId: 'codex-work',
    })
    await client!.invoke(ProviderChannels.SEND_TURN, 't1', 'first')
    await client!.invoke(ProviderChannels.SEND_TURN, 't1', 'steer the active turn')

    adapter.complete('t1')
    await expect(client!.invoke(ProviderChannels.SWITCH_INSTANCE, 't1', {
      targetInstanceId: 'codex-personal', expectedCurrentInstanceId: 'codex-work',
    })).resolves.toMatchObject({ ok: true, instanceId: 'codex-personal' })
  })

  it('rolls back to the previous profile when the target cannot start', async () => {
    const adapter = new FailingTargetAdapter()
    const { cwd } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, {
      threadId: 't1', provider: 'claude', cwd, instanceId: 'claude-work',
    })

    const result = await client!.invoke(ProviderChannels.SWITCH_INSTANCE, 't1', {
      targetInstanceId: 'claude-personal', expectedCurrentInstanceId: 'claude-work',
    })

    expect(result).toMatchObject({ ok: false, code: 'target-start-failed', rolledBack: true })
    expect(persistedInstanceSelections).toEqual([])
    expect(adapter.starts.map((start) => start.instanceId)).toEqual([
      'claude-work', 'claude-personal', 'claude-work',
    ])
  })

  it('rejects an instance belonging to another provider without touching the live session', async () => {
    const adapter = new MockEchoAdapter()
    const { cwd } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, {
      threadId: 't1', provider: 'claude', cwd, instanceId: 'claude-work',
    })

    await expect(client!.invoke(ProviderChannels.SWITCH_INSTANCE, 't1', {
      targetInstanceId: 'codex-personal', expectedCurrentInstanceId: 'claude-work',
    })).resolves.toMatchObject({ ok: false, code: 'invalid-instance' })
    expect(adapter.stops).toEqual([])
    expect(persistedInstanceSelections).toEqual([])
  })

  it('rolls back the target session when committing the selected profile fails', async () => {
    const adapter = new MockEchoAdapter()
    const { cwd, events } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, {
      threadId: 't1', provider: 'claude', cwd, instanceId: 'claude-work',
    })
    events.length = 0
    allowInstancePersistence = false

    const result = await client!.invoke(ProviderChannels.SWITCH_INSTANCE, 't1', {
      targetInstanceId: 'claude-personal', expectedCurrentInstanceId: 'claude-work',
    })

    expect(result).toMatchObject({ ok: false, code: 'target-start-failed', rolledBack: true })
    expect(persistedInstanceSelections).toEqual([])
    expect(adapter.starts.map((start) => start.instanceId)).toEqual([
      'claude-work', 'claude-personal', 'claude-work',
    ])
    expect(events.filter((event) => event.type === 'session.provider').at(-1)).toMatchObject({
      instanceId: 'claude-work',
    })
  })

  it('does not persist target lineage when the profile commit rolls back', async () => {
    recordedSegments.length = 0
    const adapter = new RotatingSessionAdapter()
    const { cwd } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, {
      threadId: 't1', provider: 'claude', cwd, instanceId: 'claude-work',
    })
    allowInstancePersistence = false

    await expect(client!.invoke(ProviderChannels.SWITCH_INSTANCE, 't1', {
      targetInstanceId: 'claude-personal', expectedCurrentInstanceId: 'claude-work',
    })).resolves.toMatchObject({ ok: false, rolledBack: true })

    expect(recordedSegments.map((segment) => segment.providerSessionId)).toEqual([
      'claude-work-session-1',
      'claude-work-session-3',
    ])
  })

  it('clears the reported profile and publishes error when rollback also fails', async () => {
    const adapter = new FailingTargetAndRollbackAdapter()
    const { cwd, events } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, {
      threadId: 't1', provider: 'claude', cwd, instanceId: 'claude-work',
    })
    events.length = 0

    await expect(client!.invoke(ProviderChannels.SWITCH_INSTANCE, 't1', {
      targetInstanceId: 'claude-personal', expectedCurrentInstanceId: 'claude-work',
    })).resolves.toMatchObject({
      ok: false,
      code: 'rollback-failed',
      rolledBack: false,
      currentInstanceId: null,
    })
    expect(events).toContainEqual(expect.objectContaining({ type: 'status', status: 'error' }))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'session.provider', instanceId: null, instanceName: null,
    }))
  })

  it('does not claim a successful rollback when stopping the old adapter fails', async () => {
    const adapter = new ThrowingStopAdapter()
    const { cwd, events } = await setup(adapter)
    await client!.invoke(ProviderChannels.START_SESSION, {
      threadId: 't1', provider: 'claude', cwd, instanceId: 'claude-work',
    })
    events.length = 0

    await expect(client!.invoke(ProviderChannels.SWITCH_INSTANCE, 't1', {
      targetInstanceId: 'claude-personal', expectedCurrentInstanceId: 'claude-work',
    })).resolves.toMatchObject({
      ok: false,
      code: 'target-start-failed',
      rolledBack: false,
      currentInstanceId: 'claude-work',
    })
    expect(events).toContainEqual(expect.objectContaining({ type: 'status', status: 'error' }))
  })
})
