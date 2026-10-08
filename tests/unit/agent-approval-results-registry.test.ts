/**
 * What happens after an agent's approval card closes, against the real
 * registry: the write runs, the chat gets a result row, and the agent gets a
 * Switchboard turn: at once when idle, queued behind a running turn, held
 * until the chat runs again, or not at all when the user answered quietly.
 * That turn is not the user's: it leaves hop depth and link budgets alone.
 * Cards and held results survive a restart (a second registry on the store).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  getConversationAgentType: () => null,
  getConversationExecutionRoot: () => null,
  getConversationProviderInstanceId: () => null,
  getSetting: () => null,
  getConversationById: (id: string) => ({ id }),
  recordConversationSegment: () => {},
  commitConversationProviderSwitch: () => {},
  setConversationProviderInstanceId: () => {},
}))

import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { createPeerToolHandlers } from '../../src/main/provider/peer-tools'
import type { AgentApprovalBroker, AgentWritePlan } from '../../src/main/mcp/agent-approvals'
import type { BackendHost } from '../../src/main/backend/host'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import {
  APPROVAL_RESULT_TAG,
  memoryApprovalCardStore,
  parseApprovalResultMarker,
  type ApprovalCardStore,
} from '../../src/shared/agent-approval-cards'
import { splitSyntheticUserText } from '../../src/shared/synthetic-message'
import type { PeerLinkView } from '../../src/shared/peer-links'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent } from '../../src/shared/provider-events'

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

/** Holds a start of the target profile until released, so a card can be answered mid-switch. */
class SwitchingAdapter implements ProviderAdapter {
  readonly provider = 'claude' as const
  readonly turns: Array<{ threadId: string; message: string }> = []
  private emit = new Map<string, (e: RuntimeEvent) => void>()
  failTarget = false
  private release: (() => void) | null = null
  targetEntered: Promise<void> = new Promise(() => {})

  holdNextTarget(): () => void {
    let entered!: () => void
    this.targetEntered = new Promise((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      this.release = resolve
    })
    this.onTarget = async () => {
      entered()
      await gate
    }
    return () => this.release?.()
  }
  private onTarget: () => Promise<void> = async () => {}

  async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    if (opts.instanceId === 'claude-personal') {
      await this.onTarget()
      if (this.failTarget) throw new Error('target auth failed')
    }
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
  async sendTurn(threadId: string, message: string): Promise<void> {
    this.turns.push({ threadId, message })
    this.emit.get(threadId)?.({ type: 'turn.completed', threadId })
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

class RecordingAdapter implements ProviderAdapter {
  readonly provider = 'claude' as const
  readonly turns: Array<{ threadId: string; message: string; delivery?: string }> = []
  private emit = new Map<string, (e: RuntimeEvent) => void>()
  /** When true, no turn.completed fires, so the thread stays mid-turn. */
  hangTurn = false

  async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
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

const registries: ProviderRegistry[] = []

function setup(store: ApprovalCardStore<AgentWritePlan> = memoryApprovalCardStore()) {
  const host = new FakeHost()
  const adapter = new RecordingAdapter()
  const registry = new ProviderRegistry(host, new Map([['claude', adapter]]), undefined, undefined, null, store)
  registry.registerIpcHandlers()
  registries.push(registry)
  saved.length = 0
  const broker = (registry as unknown as { agentApprovals: AgentApprovalBroker }).agentApprovals
  const start = async (...ids: string[]) => {
    for (const threadId of ids)
      await host.invoke(ProviderChannels.START_SESSION, { threadId, provider: 'claude', cwd: '/tmp' })
  }
  /** A card the agent in `from` opened to message `to`. */
  const openCard = (from: string, to: string, message = 'the migration landed') => {
    const opened = broker.open({
      threadId: from,
      chatId: from,
      toolName: 'mcp__switchboard__send_agent_message',
      detail: 'd',
      plan: { kind: 'peer-send', sessionId: to, message },
    })
    if (!opened.ok) throw new Error(opened.message)
    return opened.requestId
  }
  const answer = (
    threadId: string,
    requestId: string,
    decision: 'approve' | 'deny',
    response: Record<string, unknown> = {},
  ) => host.invoke(ProviderChannels.RESPOND_TO_REQUEST, threadId, requestId, decision, response)
  /** Result turns Switchboard sent into `threadId`. */
  const resultTurns = (threadId: string) =>
    adapter.turns.filter((t) => t.threadId === threadId && t.message.startsWith(`<${APPROVAL_RESULT_TAG}>`))
  const rows = (chatId: string) =>
    saved.filter((m) => m.conversationId === chatId).flatMap((m) => parseApprovalResultMarker(m.content) ?? [])
  return { host, adapter, registry, broker, start, openCard, answer, resultTurns, rows }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.stopAll()
})

describe('an approved card', () => {
  it('runs the write, records a row, and tells the idle agent in a new Switchboard turn', async () => {
    const s = setup()
    await s.start('hub', 'w1')
    const id = s.openCard('hub', 'w1')
    expect(await s.host.invoke(ProviderChannels.GET_PENDING_REQUESTS, 'hub')).toMatchObject([
      { type: 'request.opened', requestId: id },
    ])
    await s.answer('hub', id, 'approve')
    await settle()

    expect(s.adapter.turns.filter((t) => t.threadId === 'w1')).toHaveLength(1)
    const [turn] = s.resultTurns('hub')
    expect(turn.delivery).toBeUndefined()
    expect(turn.message).toContain(`approval card ${id}`)
    expect(turn.message).toContain('not from the user')
    expect(turn.message).toContain('Delivered to session w1')
    // Every surface drops the turn from the transcript; the row is what the user reads.
    expect(splitSyntheticUserText(turn.message)).toEqual({ parts: [], userText: '' })
    expect(s.rows('hub')).toEqual([
      expect.objectContaining({ requestId: id, outcome: 'done', delivery: 'turn', title: 'Message another session' }),
    ])
    expect(s.host.events).toContainEqual(
      expect.objectContaining({ type: 'approval.result', threadId: 'hub', requestId: id, messageId: `apr_${id}` }),
    )
    expect(await s.host.invoke(ProviderChannels.GET_PENDING_REQUESTS, 'hub')).toEqual([])
  })

  it('does not wake the agent when approved quietly, and says so in the row', async () => {
    const s = setup()
    await s.start('hub', 'w1')
    const id = s.openCard('hub', 'w1')
    await s.answer('hub', id, 'approve', { quiet: true })
    await settle()
    expect(s.adapter.turns.filter((t) => t.threadId === 'w1')).toHaveLength(1)
    expect(s.resultTurns('hub')).toEqual([])
    expect(s.rows('hub')).toEqual([expect.objectContaining({ outcome: 'done', delivery: 'none' })])
  })

  it('queues the result behind a running turn instead of steering it', async () => {
    const s = setup()
    await s.start('hub', 'w1')
    s.adapter.hangTurn = true
    await s.registry.deliverPeerMessage({
      fromThreadId: 'w1',
      targetThreadId: 'hub',
      text: 'busy work',
      initiator: 'user',
    })
    const id = s.openCard('hub', 'w1')
    await s.answer('hub', id, 'deny')
    await settle()
    const [turn] = s.resultTurns('hub')
    expect(turn.delivery).toBe('queue')
    expect(turn.message).toContain('The user declined')
    expect(s.rows('hub')).toEqual([expect.objectContaining({ outcome: 'declined', delivery: 'queue' })])
  })
})

describe('other ways a card closes', () => {
  it('a dismiss tells nobody; a withdrawal and a user stop are recorded but not sent to the agent', async () => {
    const s = setup()
    await s.start('hub', 'w1')
    const dismissed = s.openCard('hub', 'w1', 'one')
    await s.answer('hub', dismissed, 'deny', { quiet: true })
    const withdrawn = s.openCard('hub', 'w1', 'two')
    expect(s.broker.withdraw('hub', withdrawn)).toEqual({ ok: true })
    const stopped = s.openCard('hub', 'w1', 'three')
    await s.host.invoke(ProviderChannels.STOP_SESSION, 'hub')
    await settle()
    expect(s.resultTurns('hub')).toEqual([])
    expect(s.adapter.turns.filter((t) => t.threadId === 'w1')).toEqual([])
    expect(s.rows('hub').map((r) => [r.requestId, r.outcome, r.delivery])).toEqual([
      [dismissed, 'dismissed', 'none'],
      [withdrawn, 'withdrawn', 'none'],
      [stopped, 'stopped', 'none'],
    ])
  })
})

describe('a result turn is not the user speaking', () => {
  it('leaves the hop depth and the link budget as they were', async () => {
    const s = setup()
    await s.start('hub', 'w1', 'w2', 'w3')
    await s.host.invoke(ProviderChannels.LINK_PEER, { threadId: 'hub', peerThreadId: 'w1', messages: 5 })
    // One message along the link, then a peer message from an agent, which puts the hub at hop depth 1.
    expect(
      (await createPeerToolHandlers(s.registry, 'hub').sendMessage({ sessionId: 'w1', message: 'linked' })).isError,
    ).toBeFalsy()
    expect(
      (await createPeerToolHandlers(s.registry, 'w2').sendMessage({ sessionId: 'hub', message: 'from w2' })).isError,
    ).toBeFalsy()
    const used = async () =>
      ((await s.host.invoke(ProviderChannels.LIST_PEER_LINKS, { threadId: 'hub' })) as PeerLinkView[])[0].used
    expect(await used()).toBe(1)

    const id = s.openCard('hub', 'w3')
    await s.answer('hub', id, 'deny')
    await settle()
    expect(s.resultTurns('hub')).toHaveLength(1)

    // A user turn would have reset both. The result turn did not.
    expect(await used()).toBe(1)
    const unlinked = await createPeerToolHandlers(s.registry, 'hub').sendMessage({
      sessionId: 'w3',
      message: 'outside the link',
    })
    expect(unlinked.isError).toBe(true)
    expect(unlinked.content[0].text).toMatch(/peer message|acting on|hop/i)
    // The control: the user's own send along the edge does renew it.
    await s.registry.deliverPeerMessage({
      fromThreadId: 'hub',
      targetThreadId: 'w1',
      text: 'from the user',
      initiator: 'user',
    })
    expect(await used()).toBe(0)
  })
})

describe('a chat that is not running, and a restart', () => {
  it('holds the result until the chat runs again, then delivers it', async () => {
    const s = setup()
    await s.start('w1')
    const id = s.openCard('away', 'w1')
    await s.answer('away', id, 'approve')
    await settle()
    expect(s.rows('away')).toEqual([expect.objectContaining({ outcome: 'done', delivery: 'hold' })])
    expect(s.resultTurns('away')).toEqual([])
    await s.start('away')
    await settle()
    expect(s.resultTurns('away')).toHaveLength(1)
    expect(s.resultTurns('away')[0].message).toContain('Delivered to session w1')
  })

  it('keeps an open card across a restart; the new backend lists it and runs it once answered', async () => {
    const store = memoryApprovalCardStore<AgentWritePlan>()
    const before = setup(store)
    await before.start('hub', 'w1')
    const id = before.openCard('hub', 'w1')
    await before.registry.stopAll()

    const after = setup(store)
    await after.start('hub', 'w1')
    expect(await after.host.invoke(ProviderChannels.GET_PENDING_REQUESTS, 'hub')).toMatchObject([
      { type: 'request.opened', requestId: id },
    ])
    await after.answer('hub', id, 'approve')
    await settle()
    expect(after.adapter.turns.filter((t) => t.threadId === 'w1')).toHaveLength(1)
    expect(after.resultTurns('hub')).toHaveLength(1)
  })
})

describe('a card answered while the session is changing profiles', () => {
  async function midSwitch(failTarget: boolean) {
    const host = new FakeHost()
    const adapter = new SwitchingAdapter()
    adapter.failTarget = failTarget
    const registry = new ProviderRegistry(
      host,
      new Map([['claude', adapter]]),
      undefined,
      undefined,
      null,
      memoryApprovalCardStore(),
    )
    registry.registerIpcHandlers()
    registries.push(registry)
    saved.length = 0
    const broker = (registry as unknown as { agentApprovals: AgentApprovalBroker }).agentApprovals
    await host.invoke(ProviderChannels.START_SESSION, {
      threadId: 'hub',
      provider: 'claude',
      cwd: '/tmp',
      instanceId: 'claude-work',
    })
    const opened = broker.open({
      threadId: 'hub',
      chatId: 'hub',
      toolName: 'x',
      detail: 'd',
      plan: { kind: 'peer-send', sessionId: 'nobody', message: 'm' },
    })
    if (!opened.ok) throw new Error(opened.message)

    const release = adapter.holdNextTarget()
    const switched = host.invoke<{ ok: boolean; rolledBack?: boolean }>(ProviderChannels.SWITCH_INSTANCE, 'hub', {
      targetInstanceId: 'claude-personal',
      expectedCurrentInstanceId: 'claude-work',
    })
    await adapter.targetEntered
    await host.invoke(ProviderChannels.RESPOND_TO_REQUEST, 'hub', opened.requestId, 'deny', {})
    await settle()
    const heldDuring = adapter.turns.length
    release()
    const result = await switched
    await settle()
    const results = adapter.turns.filter((t) => t.message.startsWith(`<${APPROVAL_RESULT_TAG}>`))
    return { heldDuring, result, results, rows: saved.flatMap((m) => parseApprovalResultMarker(m.content) ?? []) }
  }

  it('holds the result during the switch and delivers it once after the commit', async () => {
    const { heldDuring, result, results, rows } = await midSwitch(false)
    expect(heldDuring).toBe(0)
    expect(result.ok).toBe(true)
    expect(results).toHaveLength(1)
    expect(rows).toEqual([expect.objectContaining({ outcome: 'declined', delivery: 'hold' })])
  })

  it('delivers it once to the restored session after a rollback', async () => {
    const { heldDuring, result, results } = await midSwitch(true)
    expect(heldDuring).toBe(0)
    expect(result).toMatchObject({ ok: false, rolledBack: true })
    expect(results).toHaveLength(1)
  })
})
