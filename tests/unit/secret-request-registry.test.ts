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

const tracked = vi.hoisted(() => [] as Array<{ event: string; properties: Record<string, unknown> }>)
vi.mock('../../src/main/analytics', () => ({
  trackAnalyticsEvent: (event: string, properties: Record<string, unknown> = {}) => tracked.push({ event, properties }),
}))

const archived = new Set<string>()
/** Rotated session id to root id, as `thread_sessions` maps them. */
const rotatedRoots = new Map<string, string>()
const saved: Array<{ id: string; conversationId: string; role: string; content: string }> = []
vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: () => {},
  updateConversationSessionId: () => {},
  resolveRootThreadId: (id: string) => rotatedRoots.get(id) ?? id,
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
import { emitConversationArchived } from '../../src/main/db/archive-events'
import type { BackendHost } from '../../src/main/backend/host'
import type { SecretStore } from '../../src/main/secrets/secret-store'
import type { McpTool } from '../../src/main/mcp/mcp-session'
import type { SwitchboardMcpServer } from '../../src/main/mcp/switchboard-mcp-server'
import { AgentSecretChannels, ProviderChannels } from '../../src/shared/ipc-channels'
import { APPROVAL_RESULT_TAG, parseApprovalResultMarker } from '../../src/shared/agent-approval-cards'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent } from '../../src/shared/provider-events'
import { PHONE_SCOPES, isChannelAllowed } from '../../src/shared/device-auth'

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
  readonly saves: Array<{ threadId: string; name: string; value: string; cardId: string; machineId?: string | null }> =
    []
  readonly removedChats: string[] = []
  readonly rows = new Map<
    string,
    {
      id: string
      rootThreadId: string
      name: string
      cardId: string
      createdAt: number
      expiresAt: number
      deletedAt: number | null
    }
  >()
  fail = false
  start(): void {}
  stop(): void {}
  chatDir(threadId: string): string {
    return `/secrets/dir-${threadId}`
  }
  save(input: {
    threadId: string
    name: string
    value: Buffer
    cardId: string
    expiresAt: number
    machineId?: string | null
  }) {
    if (this.fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    this.saves.push({
      threadId: input.threadId,
      name: input.name,
      value: input.value.toString(),
      cardId: input.cardId,
      ...(input.machineId ? { machineId: input.machineId } : {}),
    })
    const id = `sec_${this.saves.length}`
    this.rows.set(id, {
      id,
      rootThreadId: input.threadId,
      name: input.name,
      cardId: input.cardId,
      createdAt: Date.now(),
      expiresAt: input.expiresAt,
      deletedAt: null,
    })
    return { id, file: `/secrets/dir-${input.threadId}/${input.name}`, expiresAt: input.expiresAt }
  }
  extend(id: string, expiresAt: number): boolean {
    const row = this.rows.get(id)
    if (!row || row.deletedAt !== null) return false
    row.expiresAt = expiresAt
    return true
  }
  remove(id: string): boolean {
    const row = this.rows.get(id)
    if (!row || row.deletedAt !== null) return false
    row.deletedAt = Date.now()
    return true
  }
  get(id: string) {
    return this.rows.get(id) ?? null
  }
  listChat(threadId: string) {
    return [...this.rows.values()].filter((r) => r.rootThreadId === threadId)
  }
  removeChat(threadId: string): void {
    this.removedChats.push(threadId)
    for (const row of this.listChat(threadId)) row.deletedAt ??= Date.now()
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
  rotatedRoots.clear()
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
  tracked.length = 0
})

afterEach(async () => {
  delete process.env.SB_AGENT_SECRET_REQUEST
  delete process.env.SB_HUB_CHILDREN
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
    // The channel a phone's Decline goes through; its answer channel is admin only.
    expect(isChannelAllowed(PHONE_SCOPES, ProviderChannels.RESPOND_TO_REQUEST)).toBe(true)
    expect(isChannelAllowed(PHONE_SCOPES, AgentSecretChannels.ANSWER)).toBe(false)
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

  it('closes the card and deletes the files on an archive from any path (the archive listeners)', async () => {
    const s = setup()
    await s.start('chat')
    const id = await s.ask()
    archived.add('chat')
    emitConversationArchived('chat')
    expect(await s.host.invoke(ProviderChannels.GET_PENDING_REQUESTS, 'chat')).toEqual([])
    expect(s.store.removedChats).toEqual(['chat'])
    await resultPublished(s.host, id)
  })

  it.each([[{ save: 42 }], [{ save: ['x'] }], [{ decline: 'yes' }], [{ save: VALUE, decline: true }], [null]])(
    'refuses the answer %j without saving or closing the card',
    async (answer) => {
      const s = setup()
      await s.start('chat')
      const id = await s.ask()
      expect(s.registry.answerAgentSecret('chat', id, answer as never)).toMatchObject({ ok: false })
      expect(s.store.saves).toEqual([])
      expect(await s.host.invoke(ProviderChannels.GET_PENDING_REQUESTS, 'chat')).toMatchObject([{ requestId: id }])
    },
  )

  it('names the machine in the result and the row when the backend runs on one', async () => {
    const s = setup()
    s.registry.setMachineLabel('build-box')
    await s.start('chat')
    const id = await s.ask()
    expect(s.registry.answerAgentSecret('chat', id, { save: VALUE })).toEqual({ ok: true })
    await resultPublished(s.host, id)
    expect(s.store.saves[0].machineId).toBe('build-box')
    expect(s.resultTurns('chat')[0].message).toContain('Saved TAILSCALE_AUTHKEY on build-box.')
  })

  it('gives an open child chat neither the tool nor the instructions', async () => {
    process.env.SB_HUB_CHILDREN = '1'
    const s = setup()
    let instructions: string | undefined
    let names: string[] = []
    ;(s.registry as unknown as { hubStarter: { isOpenChild(id: string): boolean } }).hubStarter.isOpenChild = (id) =>
      id === 'child'
    ;(s.registry as unknown as { switchboardMcp: { open: unknown } }).switchboardMcp.open = async (
      _threadId: string,
      list: () => McpTool[],
      text?: string,
    ) => {
      instructions = text
      names = list().map((t) => t.name)
      return { command: 'node', args: [], env: {} }
    }
    await s.start('child')
    expect(names).toContain('withdraw_approval')
    expect(names).not.toContain('request_secret')
    expect(instructions ?? '').not.toContain('request_secret')
  })
})

describe('the agent-secret answer channel', () => {
  it('saves and declines through agent-secret:answer', async () => {
    const s = setup()
    await s.start('chat')
    const saveId = await s.ask()
    expect(await s.host.invoke(AgentSecretChannels.ANSWER, 'chat', saveId, { save: VALUE })).toEqual({ ok: true })
    await resultPublished(s.host, saveId)
    expect(s.store.saves).toMatchObject([{ value: VALUE, cardId: saveId }])
    const declineId = await s.ask()
    expect(await s.host.invoke(AgentSecretChannels.ANSWER, 'chat', declineId, { decline: true })).toEqual({ ok: true })
    await resultPublished(s.host, declineId)
    expect(s.store.saves).toHaveLength(1)
  })

  it('refuses every answer that is not exactly { save: string } or { decline: true }', async () => {
    const s = setup()
    await s.start('chat')
    const id = await s.ask()
    const bad: unknown[][] = [
      [42, id, { save: VALUE }],
      ['', id, { save: VALUE }],
      ['chat', 'sbapr_1', { decline: true }],
      ['chat', 7, { decline: true }],
      ['chat', id, { save: 7 }],
      ['chat', id, { decline: false }],
      ['chat', id, { decline: 'true' }],
      ['chat', id, { save: VALUE, decline: true }],
      ['chat', id, { save: VALUE, note: 'x' }],
      ['chat', id, [VALUE]],
      ['chat', id, VALUE],
      ['chat', id, null],
      ['chat', id],
    ]
    for (const args of bad)
      expect(await s.host.invoke(AgentSecretChannels.ANSWER, ...args)).toEqual({
        ok: false,
        message: 'That request is not valid.',
      })
    expect(s.store.saves).toEqual([])
    expect(await s.host.invoke(ProviderChannels.GET_PENDING_REQUESTS, 'chat')).toMatchObject([{ requestId: id }])
  })

  it('refuses every channel with the flag off', async () => {
    const s = setup()
    await s.start('chat')
    const id = await s.ask()
    expect(await s.host.invoke(AgentSecretChannels.ANSWER, 'chat', id, { save: VALUE })).toEqual({ ok: true })
    const secretId = [...s.store.rows.keys()][0]
    delete process.env.SB_AGENT_SECRET_REQUEST
    const off = { ok: false, message: 'Secret requests are turned off.' }
    expect(await s.host.invoke(AgentSecretChannels.ANSWER, 'chat', id, { decline: true })).toEqual(off)
    expect(await s.host.invoke(AgentSecretChannels.EXTEND, 'chat', secretId)).toEqual(off)
    expect(await s.host.invoke(AgentSecretChannels.DELETE, 'chat', secretId)).toEqual(off)
    expect(await s.host.invoke(AgentSecretChannels.LIST, 'chat')).toEqual(off)
    expect(s.store.rows.get(secretId)?.deletedAt).toBeNull()
  })

  it('lists the chat secrets without a value, and extends and deletes only its own', async () => {
    const s = setup()
    await s.start('chat')
    const id = await s.ask()
    expect(await s.host.invoke(AgentSecretChannels.ANSWER, 'chat', id, { save: VALUE })).toEqual({ ok: true })
    const secretId = [...s.store.rows.keys()][0]

    const listed = (await s.host.invoke(AgentSecretChannels.LIST, 'chat')) as {
      ok: true
      secrets: Array<Record<string, unknown>>
    }
    expect(listed.ok).toBe(true)
    expect(listed.secrets).toEqual([
      expect.objectContaining({ id: secretId, name: 'TAILSCALE_AUTHKEY', cardId: id, deletedAt: null, status: 'live' }),
    ])
    expect(JSON.stringify(listed)).not.toContain(VALUE)
    expect(Object.keys(listed.secrets[0]).sort()).toEqual(
      ['cardId', 'createdAt', 'deletedAt', 'expiresAt', 'id', 'name', 'status'].sort(),
    )
    expect(await s.host.invoke(AgentSecretChannels.LIST, 'other')).toEqual({ ok: true, secrets: [] })

    const gone = { ok: false, message: 'That secret is gone.' }
    const before = s.store.rows.get(secretId)!.expiresAt
    expect(await s.host.invoke(AgentSecretChannels.EXTEND, 'other', secretId)).toEqual(gone)
    expect(await s.host.invoke(AgentSecretChannels.DELETE, 'other', secretId)).toEqual(gone)
    expect(s.store.rows.get(secretId)).toMatchObject({ expiresAt: before, deletedAt: null })
    expect(await s.host.invoke(AgentSecretChannels.EXTEND, 'chat', 'sec_missing')).toEqual(gone)
    expect(await s.host.invoke(AgentSecretChannels.EXTEND, 'chat', 42)).toMatchObject({ ok: false })

    const extended = (await s.host.invoke(AgentSecretChannels.EXTEND, 'chat', secretId)) as {
      ok: true
      expiresAt: number
    }
    expect(extended.ok).toBe(true)
    expect(s.store.rows.get(secretId)?.expiresAt).toBe(extended.expiresAt)
    expect(await s.host.invoke(AgentSecretChannels.DELETE, 'chat', secretId)).toEqual({ ok: true })
    expect(await s.host.invoke(AgentSecretChannels.DELETE, 'chat', secretId)).toEqual(gone)
    const after = (await s.host.invoke(AgentSecretChannels.LIST, 'chat')) as { secrets: Array<{ status: string }> }
    expect(after.secrets.map((x) => x.status)).toEqual(['deleted'])
  })

  it('answers, extends and deletes through a rotated session id of the chat', async () => {
    const s = setup()
    await s.start('chat')
    const id = await s.ask()
    rotatedRoots.set('chat-rotated', 'chat')
    expect(await s.host.invoke(AgentSecretChannels.ANSWER, 'chat-rotated', id, { save: VALUE })).toEqual({ ok: true })
    const secretId = [...s.store.rows.keys()][0]
    expect(await s.host.invoke(AgentSecretChannels.EXTEND, 'chat-rotated', secretId)).toMatchObject({ ok: true })
    expect(await s.host.invoke(AgentSecretChannels.DELETE, 'chat-rotated', secretId)).toEqual({ ok: true })
    expect(s.store.rows.get(secretId)?.deletedAt).not.toBeNull()
  })
})

describe('secret request usage counts', () => {
  const secretEvents = () => tracked.filter((t) => t.event.startsWith('secret_request.'))

  it('counts the open, a save with its time bucket, two extends and a delete', async () => {
    const s = setup()
    await s.start('chat')
    const id = await s.ask()
    expect(s.registry.answerAgentSecret('chat', id, { save: VALUE })).toEqual({ ok: true })
    await resultPublished(s.host, id)
    const secretId = [...s.store.rows.keys()][0]
    await s.host.invoke(AgentSecretChannels.EXTEND, 'chat', secretId)
    await s.host.invoke(AgentSecretChannels.EXTEND, 'chat', secretId)
    await s.host.invoke(AgentSecretChannels.DELETE, 'chat', secretId)
    expect(secretEvents()).toEqual([
      { event: 'secret_request.opened', properties: { agentKind: 'claude', ttlBucket: '24h', remote: 'false' } },
      { event: 'secret_request.answered', properties: { outcome: 'saved', secondsBucket: 'under_30s' } },
      { event: 'secret_request.extended', properties: { count: '1' } },
      { event: 'secret_request.extended', properties: { count: '2' } },
      { event: 'secret_request.closed', properties: { outcome: 'deleted' } },
    ])
  })

  it('marks the open as remote on an SSH machine, and counts a decline', async () => {
    const s = setup()
    s.registry.setMachineLabel('build-box')
    await s.start('chat')
    const id = await s.ask()
    expect(s.registry.answerAgentSecret('chat', id, { decline: true })).toEqual({ ok: true })
    await resultPublished(s.host, id)
    expect(secretEvents()).toEqual([
      { event: 'secret_request.opened', properties: { agentKind: 'claude', ttlBucket: '24h', remote: 'true' } },
      { event: 'secret_request.answered', properties: { outcome: 'declined', secondsBucket: 'under_30s' } },
    ])
  })

  it('counts a withdrawn card, and an archive once for the open card and once per live file', async () => {
    const s = setup()
    await s.start('chat')
    const withdrawn = await s.ask()
    await s.tool('withdraw_approval')!.call({ card: withdrawn })
    await resultPublished(s.host, withdrawn)
    const saved = await s.ask()
    expect(s.registry.answerAgentSecret('chat', saved, { save: VALUE })).toEqual({ ok: true })
    await resultPublished(s.host, saved)
    const open = await s.ask()
    tracked.length = 0
    archived.add('chat')
    notifyConversationArchived('chat')
    await resultPublished(s.host, open)
    expect(secretEvents()).toEqual([
      { event: 'secret_request.closed', properties: { outcome: 'archived' } },
      { event: 'secret_request.closed', properties: { outcome: 'archived' } },
    ])
  })

  it('counts nothing with the flag off, also when an archive closes a card opened while it was on', async () => {
    const s = setup()
    await s.start('chat')
    const id = await s.ask()
    tracked.length = 0
    delete process.env.SB_AGENT_SECRET_REQUEST
    archived.add('chat')
    notifyConversationArchived('chat')
    await resultPublished(s.host, id)
    expect(secretEvents()).toEqual([])
  })

  it('counts each refusal by its reason', async () => {
    const s = setup()
    await s.start('chat')
    const request = s.tool('request_secret')!
    await request.call({ name: 'lower', title: 'x', instructions: 'y' })
    for (let i = 0; i < 3; i++) await s.ask()
    await request.call({ name: 'FOURTH_KEY', title: 'x', instructions: 'y' })
    expect(secretEvents().filter((t) => t.event === 'secret_request.refused')).toEqual([
      { event: 'secret_request.refused', properties: { reason: 'invalid' } },
      { event: 'secret_request.refused', properties: { reason: 'cap' } },
    ])
  })
})
