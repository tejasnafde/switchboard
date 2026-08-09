/**
 * The make-or-break test for the remote refactor: provider control + event
 * streaming + mid-session model/instance switching, all driven across a real
 * WebSocket (WsTransport → WsHost → ProviderRegistry → mock adapter → host.emit
 * → back over the wire). Proves the daily plan-hopping workflow survives a
 * backend running on a VM, with no Electron and no real provider auth.
 *
 * DB access in the registry's START_SESSION path is mocked - this exercises the
 * transport + registry + adapter wiring, not SQLite.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type AddressInfo } from 'ws'

vi.mock('../../src/main/db/providerInstances', () => ({
  resolveProviderInstance: (agentType: string, id?: string) => ({
    id: id ?? `${agentType}-default`,
    env: {},
    oauthDir: null,
  }),
  listOauthDirsForAgent: () => [],
}))
/** Records what the registry persists, so a missing method cannot pass as a log line. */
const saved: Array<{ id: string; conversationId: string; role: string; content: string; images?: string }> = []
vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: () => {},
  updateConversationSessionId: () => {},
  saveMessageIfAbsent: (id: string, conversationId: string, role: string, content: string, images?: string) => {
    saved.push({ id, conversationId, role, content, images })
    return true
  },
  // Read by the session-defaults chain on every start. Null throughout, so
  // these tests keep asserting that the REQUEST wins, which is the tier they
  // exercise.
  getConversationRuntimeMode: () => null,
  getConversationModel: () => null,
  getConversationAgentType: () => null,
  getConversationProviderInstanceId: () => null,
  getSetting: () => null,
}))

import { WsHost } from '../../src/main/backend/ws-host'
import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { WsTransport } from '../../src/shared/ws-transport'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent } from '../../src/shared/provider-events'

// Echoes each turn back as a content event tagged with the current model, so a
// model switch is observable in the stream. One adapter instance, many threads.
class MockEchoAdapter implements ProviderAdapter {
  readonly provider = 'claude' as const
  private emit = new Map<string, (e: RuntimeEvent) => void>()
  private model = new Map<string, string>()
  private turn = 0

  async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
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
    this.emit.delete(threadId)
    this.model.delete(threadId)
  }
  async setRuntimeMode(): Promise<void> {}
  async isAvailable(): Promise<boolean> {
    return true
  }
}

let wss: WebSocketServer | null = null
let client: WsTransport | null = null
let registry: ProviderRegistry | null = null
/** Scratch cwds this file created, removed in afterEach so repeated runs do not
 *  pile up dirs under TMPDIR. */
const scratchDirs: string[] = []

async function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'sb-prov-'))
  scratchDirs.push(cwd)
  wss = new WebSocketServer({ port: 0 })
  const host = new WsHost(wss)
  registry = new ProviderRegistry(host, new Map([['claude', new MockEchoAdapter()]]))
  registry.registerIpcHandlers()
  await new Promise<void>((res) => wss!.on('listening', () => res()))
  const { port } = wss.address() as AddressInfo

  const events: RuntimeEvent[] = []
  client = new WsTransport(`ws://localhost:${port}`)
  client.on(ProviderChannels.EVENT, (e: RuntimeEvent) => events.push(e))
  return { cwd, events }
}

const flush = () => new Promise((r) => setTimeout(r, 40))

afterEach(async () => {
  client?.close()
  client = null
  await registry?.stopAll()
  registry = null
  await new Promise<void>((res) => (wss ? wss.close(() => res()) : res()))
  wss = null
  while (scratchDirs.length) rmSync(scratchDirs.pop()!, { recursive: true, force: true })
})

describe('provider switching over the WebSocket boundary', () => {
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

  // The renderer was the only writer of `messages`, so a turn sent from the
  // phone left no row at all: no search hit, no DB fallback, and `updated_at`
  // never moved so the chat stayed buried in the phone's own sort.
  it('persists a turn sent by a client that is not the desktop renderer', async () => {
    const { cwd } = await setup()
    saved.length = 0
    await client!.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd })
    await client!.invoke(ProviderChannels.SEND_TURN, 't1', 'from the phone', undefined, undefined, 'o-1')
    await flush()

    const turn = saved.find((m) => m.role === 'user')
    expect(turn).toBeDefined()
    expect(turn?.content).toBe('from the phone')
    expect(turn?.conversationId).toBe('t1')
    // echoMessageId(origin) - the id the optimistic bubble already uses, so the
    // renderer's own richer write targets this row instead of adding a second.
    expect(turn?.id).toBe('remote_o-1')
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
})
