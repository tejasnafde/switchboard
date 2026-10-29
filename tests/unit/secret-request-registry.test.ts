/**
 * The secret request flow against the real registry, with the file store
 * replaced by a recorder: the tool is listed only with the flag on, a save
 * writes through the store and tells the agent the path and the env var,
 * never the value; a failed save keeps the card open; decline, Stop, archive,
 * and a phone-style approval on the generic channel.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { until } from './helpers/wait'
import './helpers/registry-session-mocks'

vi.mock('../../src/main/db/provider-instances', () => ({
  resolveProviderInstance: (agentType: string, id?: string) => ({
    id: id ?? `${agentType}-default`,
    agentType,
    displayName: id ?? `${agentType}-default`,
    enabled: true,
    env: {},
    oauthDir: null,
  }),
  getProviderInstanceFull: (id: string) => ({
    id,
    agentType: 'claude-code',
    displayName: id,
    enabled: true,
    env: {},
    oauthDir: null,
  }),
  listOauthDirsForAgent: () => [],
}))

const archived = new Set<string>()
const saved: Array<{ id: string; conversationId: string; role: string; content: string }> = []
vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: () => {},
  updateConversationSessionId: () => {},
  resolveRootThreadId: (id: string) => id,
  getConversationTitle: () => null,
  rewriteSystemMarker: () => null,
  saveMessageIfAbsent: (id: string, conversationId: string, role: string, content: string) => {
    if (saved.some((m) => m.id === id)) return false
    saved.push({ id, conversationId, role, content })
    return true
  },
  getConversationRuntimeMode: () => null,
  getConversationModel: () => null,
  getConversationReasoningEffort: () => null,
  getConversationAgentType: () => null,
  getConversationExecutionRoot: () => null,
  getConversationProviderInstanceId: () => null,
  getSetting: () => null,
  getConversationById: (id: string) => ({ id }),
  recordConversationSegment: () => {},
  commitConversationProviderSwitch: () => {},
  setConversationProviderInstanceId: () => {},
  isConversationArchived: (id: string) => archived.has(id),
}))

import { ProviderRegistry, notifyConversationArchived } from '../../src/main/provider/provider-registry'
import type { BackendHost } from '../../src/main/backend/host'
import type { SecretStore } from '../../src/main/secrets/secret-store'
import type { McpTool } from '../../src/main/mcp/mcp-session'
import type { SwitchboardMcpServer } from '../../src/main/mcp/switchboard-mcp-server'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import { APPROVAL_RESULT_TAG, parseApprovalResultMarker } from '../../src/shared/agent-approval-cards'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent } from '../../src/shared/provider-events'

const PROJECT_DIR = mkdtempSync(join(tmpdir(), 'sb-secret-registry-'))
afterAll(() => rmSync(PROJECT_DIR, { recursive: true, force: true }))
const VALUE = 'sb-test-not-a-secret'

class FakeHost implements BackendHost {
  readonly events: RuntimeEvent[] = []
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn)
  }
  on(): void {}
  emit(channel: string, event: unknown): void {
    if (channel === ProviderChannels.EVENT) this.events.push(event as RuntimeEvent)
  }
  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    const fn = this.handlers.get(channel)
    if (!fn) throw new Error(`no handler registered for ${channel}`)
    return (await fn(...args)) as T
  }
}

class RecordingAdapter implements ProviderAdapter {
  readonly provider = 'claude' as const
  readonly turns: Array<{ threadId: string; message: string; delivery?: string }> = []
  private emit = new Map<string, (e: RuntimeEvent) => void>()
  /** When true, no turn.completed fires, so the thread stays mid-turn. */
  hangTurn = false

  readonly starts: SessionStartOpts[] = []
  async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    this.starts.push(opts)
    this.emit.set(opts.threadId, onEvent)
    return {
      threadId: opts.threadId,
      provider: 'claude',
      status: 'ready',
      runtimeMode: opts.runtimeMode ?? 'sandbox',
      cwd: opts.cwd,
      createdAt: 0,
    }
  }
  async sendTurn(
    threadId: string,
    message: string,
    _mode?: unknown,
    _images?: unknown,
    delivery?: string,
  ): Promise<void> {
    this.turns.push({ threadId, message, ...(delivery ? { delivery } : {}) })
    if (!this.hangTurn) this.emit.get(threadId)?.({ type: 'turn.completed', threadId })
  }
  async respondToRequest(): Promise<void> {}
  async interruptTurn(): Promise<void> {}
  async stopSession(threadId: string): Promise<void> {
    this.emit.delete(threadId)
  }
  async setRuntimeMode(): Promise<void> {}
  async isAvailable(): Promise<boolean> {
    return true
  }
}

class FakeSecretStore {
  readonly saves: Array<{ threadId: string; name: string; value: string; cardId: string }> = []
  readonly removedChats: string[] = []
  fail = false
  start(): void {}
  stop(): void {}
  chatDir(threadId: string): string {
    return `/secrets/dir-${threadId}`
  }
  save(input: { threadId: string; name: string; value: Buffer; cardId: string; expiresAt: number }) {
    if (this.fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    this.saves.push({ threadId: input.threadId, name: input.name, value: input.value.toString(), cardId: input.cardId })
    return { id: 'sec_1', file: `/secrets/dir-${input.threadId}/${input.name}`, expiresAt: input.expiresAt }
  }
  extend(): boolean {
    return true
  }
  remove(): boolean {
    return true
  }
  removeChat(threadId: string): void {
    this.removedChats.push(threadId)
  }
}

const registries: ProviderRegistry[] = []

function setup() {
  const host = new FakeHost()
  const adapter = new RecordingAdapter()
  const store = new FakeSecretStore()
  let tools: () => McpTool[] = () => []
  const mcp = {
    open: async (_threadId: string, list: () => McpTool[]) => {
      tools = list
      return { command: 'node', args: [], env: {} }
    },
    close: () => {},
  } as unknown as SwitchboardMcpServer
  const registry = new ProviderRegistry(
    host,
    new Map([['claude', adapter]]),
    undefined,
    undefined,
    mcp,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    store as unknown as SecretStore,
  )
  registry.registerIpcHandlers()
  registries.push(registry)
  saved.length = 0
  archived.clear()
  const start = (threadId: string) =>
    host.invoke(ProviderChannels.START_SESSION, { threadId, provider: 'claude', cwd: PROJECT_DIR })
  const tool = (name: string) => tools().find((t) => t.name === name)
  const ask = async (threadId = 'chat') => {
    const result = await tool('request_secret')!.call({
      name: 'TAILSCALE_AUTHKEY',
      title: 'Tailscale auth key',
      instructions: 'Make one at https://login.tailscale.com/admin/settings/keys',
    })
    const id = /card (sbsec_\S+)\)/.exec(result.content[0].text)?.[1]
    if (!id) throw new Error(result.content[0].text)
    return id
  }
  const resultTurns = (threadId: string) =>
    adapter.turns.filter((t) => t.threadId === threadId && t.message.startsWith(`<${APPROVAL_RESULT_TAG}>`))
  return { host, adapter, store, registry, start, tool, ask, resultTurns }
}

const resultPublished = (host: FakeHost, requestId: string) =>
  until(() => expect(host.events).toContainEqual(expect.objectContaining({ type: 'approval.result', requestId })))

beforeEach(() => {
  process.env.SB_AGENT_SECRET_REQUEST = '1'
})

afterEach(async () => {
  delete process.env.SB_AGENT_SECRET_REQUEST
  for (const registry of registries.splice(0)) await registry.stopAll()
})

describe('request_secret in the registry', () => {
  it('is not listed and sets no env var with the flag off', async () => {
    delete process.env.SB_AGENT_SECRET_REQUEST
    const s = setup()
    await s.start('chat')
    expect(s.tool('request_secret')).toBeUndefined()
    expect(s.adapter.starts[0].resolvedEnv?.SWITCHBOARD_SECRETS_DIR).toBeUndefined()
  })

  it('is listed with the flag on, and the session gets the folder path as SWITCHBOARD_SECRETS_DIR', async () => {
    const s = setup()
    await s.start('chat')
    expect(s.tool('request_secret')).toBeDefined()
    expect(s.adapter.starts[0].resolvedEnv?.SWITCHBOARD_SECRETS_DIR).toBe('/secrets/dir-chat')
  })

  it('opens an sbsec_ card whose detail has no title, and a save tells the agent the path, never the value', async () => {
    const s = setup()
    await s.start('chat')
    const id = await s.ask()
    const [opened] = (await s.host.invoke(ProviderChannels.GET_PENDING_REQUESTS, 'chat')) as RuntimeEvent[]
    expect(opened).toMatchObject({ requestId: id, secretRequest: { name: 'TAILSCALE_AUTHKEY', ttl: '24h' } })
    expect((opened as { detail: string }).detail).not.toContain('Tailscale')

    expect(s.registry.answerAgentSecret('chat', id, { save: VALUE })).toEqual({ ok: true })
    await resultPublished(s.host, id)
    expect(s.store.saves).toEqual([{ threadId: 'chat', name: 'TAILSCALE_AUTHKEY', value: VALUE, cardId: id }])
    const [turn] = s.resultTurns('chat')
    expect(turn.message).toContain('/secrets/dir-chat/TAILSCALE_AUTHKEY')
    expect(turn.message).toContain('SWITCHBOARD_SECRETS_DIR')
    expect(turn.message).not.toContain(VALUE)
    expect(JSON.stringify(saved)).not.toContain(VALUE)
    expect(JSON.stringify(s.host.events)).not.toContain(VALUE)
    expect(saved.map((m) => parseApprovalResultMarker(m.content)?.outcome)).toEqual(['done'])
    expect(s.registry.answerAgentSecret('chat', id, { save: VALUE })).toMatchObject({ ok: false })
  })

  it('keeps the card open when the save fails', async () => {
    const s = setup()
    await s.start('chat')
    const id = await s.ask()
    s.store.fail = true
    expect(s.registry.answerAgentSecret('chat', id, { save: VALUE })).toMatchObject({ ok: false })
    expect(await s.host.invoke(ProviderChannels.GET_PENDING_REQUESTS, 'chat')).toMatchObject([{ requestId: id }])
    expect(s.resultTurns('chat')).toEqual([])
  })

  it('declines without a value', async () => {
    const s = setup()
    await s.start('chat')
    const id = await s.ask()
    expect(s.registry.answerAgentSecret('chat', id, { decline: true })).toEqual({ ok: true })
    await resultPublished(s.host, id)
    expect(s.store.saves).toEqual([])
    expect(s.resultTurns('chat')[0].message).toContain('declined to give TAILSCALE_AUTHKEY')
  })

  it('refuses an approval on the generic channel but takes a deny there', async () => {
    const s = setup()
    await s.start('chat')
    const id = await s.ask()
    await expect(
      s.host.invoke(ProviderChannels.RESPOND_TO_REQUEST, 'chat', id, 'approve', { text: VALUE }),
    ).rejects.toThrow(/on your computer/)
    await s.host.invoke(ProviderChannels.RESPOND_TO_REQUEST, 'chat', id, 'deny', {})
    await resultPublished(s.host, id)
    expect(s.store.saves).toEqual([])
  })

  it('keeps the card on a Stop, and closes it and deletes the files on an archive', async () => {
    const s = setup()
    await s.start('chat')
    const id = await s.ask()
    await s.host.invoke(ProviderChannels.STOP_SESSION, 'chat')
    expect(await s.host.invoke(ProviderChannels.GET_PENDING_REQUESTS, 'chat')).toMatchObject([{ requestId: id }])
    expect(s.store.removedChats).toEqual([])
    archived.add('chat')
    notifyConversationArchived('chat')
    expect(await s.host.invoke(ProviderChannels.GET_PENDING_REQUESTS, 'chat')).toEqual([])
    expect(s.store.removedChats).toEqual(['chat'])
    expect(s.registry.answerAgentSecret('chat', id, { save: VALUE })).toMatchObject({ ok: false })
  })
})
