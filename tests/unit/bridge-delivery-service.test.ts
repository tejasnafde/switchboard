/**
 * The bridge's owner delivery on a real migrated database and the real
 * durable atomic user-turn acceptance, with a fake registry host: start,
 * send and stop, idempotent replay and conflict, the mode cap, agent and
 * model choices, queue and steer fallback (compaction, an ACP agent),
 * dormant and rotated chats, archived and child chats, the one active
 * bridge group, stop during a start, and a crash after the provider took the
 * turn (the retry finds the same message id and sends nothing).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMigratedDb } from './helpers/test-db'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/switchboard-vitest') } }))

vi.mock('../../src/main/conversations/history', async () => {
  const db = await import('../../src/main/db/database')
  return {
    loadConversationHistoryWindow: async (id: string) => {
      const messages = db
        .messageRowsToChatMessages(db.threadFamilyIds(id).flatMap((f) => db.getMessagesForConversation(f)))
        .sort((a, b) => a.timestamp - b.timestamp)
      return { messages, total: messages.length }
    },
  }
})

import {
  addProject,
  archiveConversation,
  createConversation,
  getBridgeCall,
  getBridgeOrigin,
  getConversationById,
  getConversationRuntimeMode,
  getDb,
  getMessagesForConversation,
  listBridgeProjectPolicies,
  recordThreadSession,
  resolveRootThreadId,
  saveBridgeProjectPolicy,
  setConversationRuntimeMode,
  setConversationWorktree,
} from '../../src/main/db/database'
import { SqliteTurnAcceptanceStore } from '../../src/main/db/turn-acceptance'
import { AtomicUserTurnSubmission } from '../../src/main/provider/durable-turn-acceptance'
import { setBridgeProjectAllowed } from '../../src/main/bridge/allowlist'
import { BridgeReadService } from '../../src/main/bridge/read-service'
import {
  BridgeDeliveryService,
  type BridgeCaller,
  type BridgeDeliveryHost,
} from '../../src/main/bridge/delivery-service'
import { buildBridgeTools } from '../../src/main/mcp/bridge-tools'
import type { SessionStartOpts } from '../../src/main/provider/types'
import type { PendingBlockingEvent } from '../../src/shared/pending-requests'
import {
  SESSION_START_STOPPED,
  type RuntimeMode,
  type UserTurnSubmissionResult,
  type UserTurnSubmissionV1,
} from '../../src/shared/provider-events'
import type { QueuedTurnSummary } from '../../src/shared/turn-delivery'
import type { AgentType } from '../../src/shared/types'

const MACHINE = 'hub-test-machine'
const ROOT = mkdtempSync(join(tmpdir(), 'sb-bridge-delivery-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))
const ALLOWED = join(ROOT, 'allowed')
const OTHER = join(ROOT, 'other')
mkdirSync(ALLOWED, { recursive: true })
mkdirSync(OTHER, { recursive: true })

interface LiveChat {
  provider: string
  midTurn: boolean
  steerBlocked: boolean
}

class FakeHost implements BridgeDeliveryHost {
  flag = true
  live = new Map<string, LiveChat>()
  busyChats = new Set<string>()
  startingThreads = new Set<string>()
  openChildren = new Set<string>()
  pending = new Map<string, PendingBlockingEvent[]>()
  queued = new Map<string, QueuedTurnSummary[]>()
  starts: SessionStartOpts[] = []
  dispatched: UserTurnSubmissionV1[] = []
  interrupts: string[] = []
  cancelled: string[] = []
  /** Runs instead of the default start. */
  onStart: ((opts: SessionStartOpts) => Promise<void>) | null = null
  /** The provider takes the turn, then the process "dies" before the answer. */
  dieAfterDispatch = false
  private readonly atomic = new AtomicUserTurnSubmission({
    store: new SqliteTurnAcceptanceStore(() => getDb()),
    publish: () => {},
  })

  enabled = () => this.flag
  machineId = () => MACHINE
  liveThread = (chatId: string) => {
    if (this.live.has(chatId)) return chatId
    const root = resolveRootThreadId(chatId)
    for (const id of this.live.keys()) if (resolveRootThreadId(id) === root) return id
    return null
  }
  starting = (threadId: string) => this.startingThreads.has(threadId)
  startSession = async (opts: SessionStartOpts) => {
    this.starts.push(opts)
    if (this.onStart) return this.onStart(opts)
    this.live.set(opts.threadId, { provider: opts.provider, midTurn: false, steerBlocked: false })
  }
  submitTurn = async (input: UserTurnSubmissionV1): Promise<UserTurnSubmissionResult> => {
    const result = await this.atomic.submit(input, {
      clientScope: 'test-scope',
      conversationId: resolveRootThreadId(input.threadId),
      prepare: async () => {},
      dispatch: async (turn) => {
        this.dispatched.push(turn)
      },
    })
    if (this.dieAfterDispatch) throw new Error('backend died')
    return result
  }
  provider = (threadId: string) => this.live.get(threadId)?.provider ?? null
  midTurn = (threadId: string) => this.live.get(threadId)?.midTurn ?? false
  steerBlocked = (threadId: string) => this.live.get(threadId)?.steerBlocked ?? false
  busy = (chatId: string) => this.busyChats.has(resolveRootThreadId(chatId))
  chatMode = (chatId: string) => (getConversationRuntimeMode(resolveRootThreadId(chatId)) ?? 'sandbox') as RuntimeMode
  isOpenChild = (chatId: string) => this.openChildren.has(resolveRootThreadId(chatId))
  agentAvailable = async (agent: AgentType) => agent !== 'gemini'
  interrupt = async (threadId: string) => {
    this.interrupts.push(threadId)
  }
  queuedTurns = (threadId: string) => this.queued.get(threadId) ?? []
  cancelQueuedTurn = async (threadId: string, messageId: string) => {
    this.cancelled.push(messageId)
    const turn = this.queuedTurns(threadId).find((q) => q.messageId === messageId)!
    return { ok: true as const, turn }
  }
}

let host: FakeHost
let reads: BridgeReadService
let delivery: BridgeDeliveryService
const agent = (mode: RuntimeMode = 'full-access'): BridgeCaller => ({ kind: 'local-agent', chatId: 'caller', mode })

type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string } & Record<string, unknown> }
const ok = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.value
}
const err = <T>(r: Result<T>) => {
  if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.value)}`)
  return r.error
}

let keySeq = 0
const key = () => `k${++keySeq}`

function start(extra: Record<string, unknown> = {}, caller = agent()) {
  return delivery.startChat(caller, {
    project: 'Raves site',
    message: 'Fix the header',
    idempotency_key: key(),
    ...extra,
  })
}

function idleChat(id: string, provider = 'claude', mode: RuntimeMode = 'auto') {
  createConversation(id, ALLOWED, provider === 'claude' ? 'claude-code' : provider)
  setConversationRuntimeMode(id, mode)
  host.live.set(id, { provider, midTurn: false, steerBlocked: false })
}

beforeEach(() => {
  createMigratedDb()
  host = new FakeHost()
  reads = new BridgeReadService({
    machineId: () => MACHINE,
    live: { status: () => null, busy: (id) => host.busy(id), pending: (id) => host.pending.get(id) ?? [] },
  })
  delivery = new BridgeDeliveryService(host, reads)
  addProject(ALLOWED, 'Raves site')
  addProject(OTHER, 'Other')
  setBridgeProjectAllowed(ALLOWED, true, MACHINE)
  const [policy] = listBridgeProjectPolicies()
  saveBridgeProjectPolicy({ ...policy, allowed_agents: ['claude-code', 'codex', 'opencode'] })
})

describe('start_chat', () => {
  it('stores the chat, its mode and its origin before the start, then sends the first turn atomically', async () => {
    host.onStart = async (opts) => {
      // Persisted before the provider starts.
      expect(getConversationById(opts.threadId)?.project_path).toBe(ALLOWED)
      expect(getConversationRuntimeMode(opts.threadId)).toBe('auto')
      expect(getBridgeOrigin(opts.threadId)).not.toBeNull()
      host.live.set(opts.threadId, { provider: opts.provider, midTurn: false, steerBlocked: false })
    }
    const receipt = ok(await start())
    expect(receipt).toMatchObject({ state: 'accepted', replayed: false, agent: 'claude-code', mode: 'auto' })
    expect(receipt.message_id).toBe(`remote_bridge-${receipt.call_id}`)
    expect(host.starts[0]).toMatchObject({ threadId: receipt.chat.chat_id, provider: 'claude', cwd: ALLOWED })
    const stored = getMessagesForConversation(receipt.chat.chat_id)
    expect(stored.map((m) => [m.id, m.role, m.content])).toEqual([[receipt.message_id, 'user', 'Fix the header']])
    expect(getConversationById(receipt.chat.chat_id)?.title).not.toBe('New conversation')
    expect(getBridgeOrigin(receipt.chat.chat_id)?.callId).toBe(receipt.call_id)
  })

  it('replays the same key and body, refuses a changed body, and never sends twice', async () => {
    const args = { project: 'Raves site', message: 'Fix the header', idempotency_key: 'same' }
    const first = ok(await delivery.startChat(agent(), args))
    const again = ok(await delivery.startChat(agent(), args))
    expect(again).toMatchObject({ call_id: first.call_id, replayed: true, message_id: first.message_id })
    expect(host.dispatched).toHaveLength(1)
    expect(err(await delivery.startChat(agent(), { ...args, message: 'Other' }))).toMatchObject({
      code: 'idempotency_conflict',
      call_id: first.call_id,
    })
    // Another chat's key is its own.
    const other = ok(await delivery.startChat({ ...agent(), chatId: 'caller-2' }, args))
    expect(other.call_id).not.toBe(first.call_id)
  })

  it('caps the mode at the policy and the caller, and refuses plan-mode callers', async () => {
    expect(err(await start({ mode: 'full-access' }))).toMatchObject({ code: 'mode_not_allowed' })
    expect(err(await start({ mode: 'yolo' }))).toMatchObject({ code: 'mode_not_allowed' })
    expect(err(await start({ mode: 'auto' }, agent('sandbox')))).toMatchObject({ code: 'mode_not_allowed' })
    expect(err(await start({}, agent('plan')))).toMatchObject({ code: 'policy_denied' })
    const narrowed = ok(await start({}, agent('sandbox')))
    expect(narrowed.mode).toBe('sandbox')
    expect(getConversationRuntimeMode(narrowed.chat.chat_id)).toBe('sandbox')
    expect(host.dispatched[0].runtimeMode).toBe('sandbox')
  })

  it('returns choices for an agent or model the project does not offer', async () => {
    const [policy] = listBridgeProjectPolicies()
    saveBridgeProjectPolicy({ ...policy, allowed_agents: ['claude-code', 'codex', 'gemini'] })
    expect(err(await start({ agent: 'opencode' }))).toMatchObject({
      code: 'agent_unavailable',
      agent_choices: ['claude-code', 'codex', 'gemini'],
    })
    expect(err(await start({ agent: 'gemini' }))).toMatchObject({ code: 'agent_unavailable' })
    const model = err(await start({ agent: 'codex', model: 'gpt-0' }))
    expect(model.code).toBe('agent_unavailable')
    expect(model.model_choices).toContain('gpt-5.5')
    expect(host.starts).toHaveLength(0)
    expect(ok(await start({ agent: 'codex', model: 'gpt-5.5' }))).toMatchObject({ agent: 'codex', model: 'gpt-5.5' })
  })

  it('refuses a project off the allowlist and answers bridge_disabled with the flag off', async () => {
    expect(err(await start({ project: 'Other' }))).toMatchObject({ code: 'project_not_allowed' })
    host.flag = false
    expect(err(await start())).toMatchObject({ code: 'bridge_disabled' })
    expect(err(await delivery.sendToChat(agent(), { chat: 'x', message: 'm', idempotency_key: 'k' }))).toMatchObject({
      code: 'bridge_disabled',
    })
    expect(err(await delivery.stopChat(agent(), { chat: 'x', idempotency_key: 'k' }))).toMatchObject({
      code: 'bridge_disabled',
    })
  })

  it('allows one active bridge group per machine; sends into that chat still go in', async () => {
    const first = ok(await start())
    host.busyChats.add(first.chat.chat_id)
    expect(err(await start({ message: 'Second job' }))).toMatchObject({
      code: 'policy_denied',
      target: { chat_id: first.chat.chat_id },
    })
    host.live.get(first.chat.chat_id)!.midTurn = true
    expect(
      ok(await delivery.sendToChat(agent(), { chat: first.chat, message: 'Also this', idempotency_key: key() })),
    ).toMatchObject({ state: 'accepted', delivery: { requested: 'queue', actual: 'queue' } })
    host.busyChats.clear()
    expect(ok(await start({ message: 'Second job' })).state).toBe('accepted')
  })

  it('a stop during the start fences it: the first message never goes out', async () => {
    let release!: () => void
    host.onStart = (opts) => {
      host.startingThreads.add(opts.threadId)
      return new Promise<void>((_resolve, reject) => {
        release = () => {
          host.startingThreads.delete(opts.threadId)
          reject(new Error(SESSION_START_STOPPED))
        }
      })
    }
    const starting = start()
    await vi.waitFor(() => expect(host.starts).toHaveLength(1))
    const chatId = host.starts[0].threadId
    const stopped = ok(await delivery.stopChat(agent(), { chat: chatId, idempotency_key: key() }))
    expect(stopped).toMatchObject({ state: 'accepted', status: 'stopped' })
    expect(host.interrupts).toEqual([chatId])
    release()
    const refused = err(await starting)
    expect(refused).toMatchObject({ code: 'policy_denied', non_delivery_confirmed: true })
    expect(host.dispatched).toHaveLength(0)
    expect(getBridgeCall(refused.call_id as string)?.state).toBe('rejected')
  })

  it('a crash after the provider took the turn replays the same message id and sends nothing again', async () => {
    host.dieAfterDispatch = true
    const args = { project: 'Raves site', message: 'Fix the header', idempotency_key: 'crash' }
    const lost = err(await delivery.startChat(agent(), args))
    expect(lost.code).toBe('delivery_unknown')
    expect(host.dispatched).toHaveLength(1)
    // A restarted backend: a new service, nothing in flight.
    host.dieAfterDispatch = false
    const restarted = new BridgeDeliveryService(host, reads)
    const replay = ok(await restarted.startChat(agent(), args))
    expect(replay).toMatchObject({ call_id: lost.call_id, state: 'accepted', replayed: true })
    expect(replay.message_id).toBe(`remote_bridge-${lost.call_id}`)
    expect(host.dispatched).toHaveLength(1)
    expect(getMessagesForConversation(replay.chat.chat_id)).toHaveLength(1)
  })

  it('a turn still dispatching at the crash stays delivery_unknown; one never dispatched is rejected', async () => {
    const args = { project: 'Raves site', message: 'Fix the header', idempotency_key: 'mid' }
    host.submitTurn = async (input) => {
      // The acceptance row is left mid-dispatch, as a crash at the provider boundary leaves it.
      getDb()
        .prepare(
          `INSERT INTO mobile_turn_acceptances (client_scope, thread_id, origin, payload_hash, state, accepted_at)
           VALUES ('s', ?, ?, 'h', 'dispatching', 1)`,
        )
        .run(resolveRootThreadId(input.threadId), input.origin)
      throw new Error('backend died')
    }
    const first = err(await delivery.startChat(agent(), args))
    const restarted = new BridgeDeliveryService(host, reads)
    expect(err(await restarted.startChat(agent(), args))).toMatchObject({
      code: 'delivery_unknown',
      call_id: first.call_id,
    })

    // Recorded but never dispatched: confirmed non-delivery.
    const never = { project: 'Raves site', message: 'Never sent', idempotency_key: 'never' }
    host.onStart = () => new Promise(() => {})
    void delivery.startChat(agent(), never)
    await vi.waitFor(() => expect(host.starts.length).toBeGreaterThan(1))
    expect(err(await new BridgeDeliveryService(host, reads).startChat(agent(), never))).toMatchObject({
      non_delivery_confirmed: true,
    })
  })
})

describe('send_to_chat', () => {
  it('sends an idle chat a normal turn, as a queue send that cannot become a steer', async () => {
    idleChat('c1')
    const receipt = ok(await delivery.sendToChat(agent(), { chat: 'c1', message: 'Next', idempotency_key: key() }))
    expect(receipt).toMatchObject({ state: 'accepted', delivery: { requested: 'queue', actual: 'turn' } })
    expect(host.dispatched[0]).toMatchObject({ threadId: 'c1', delivery: 'queue', providerText: 'Next' })
    expect(host.dispatched[0].runtimeMode).toBeUndefined()
    expect(getBridgeOrigin('c1')?.callId).toBe(receipt.call_id)
  })

  it('steers only when asked, supported and not compacting; otherwise queues', async () => {
    idleChat('c1')
    host.live.get('c1')!.midTurn = true
    const send = (delivery_?: 'queue' | 'steer') =>
      delivery.sendToChat(agent(), { chat: 'c1', message: 'x', delivery: delivery_, idempotency_key: key() })
    expect(ok(await send()).delivery).toEqual({ requested: 'queue', actual: 'queue' })
    expect(ok(await send('steer')).delivery).toEqual({ requested: 'steer', actual: 'steer' })
    expect(host.dispatched.at(-1)?.delivery).toBe('steer')
    host.live.get('c1')!.steerBlocked = true
    expect(ok(await send('steer')).delivery).toEqual({ requested: 'steer', actual: 'queue' })
    expect(host.dispatched.at(-1)?.delivery).toBe('queue')

    idleChat('c2', 'opencode')
    host.live.get('c2')!.midTurn = true
    const acp = ok(
      await delivery.sendToChat(agent(), { chat: 'c2', message: 'x', delivery: 'steer', idempotency_key: key() }),
    )
    expect(acp.delivery).toEqual({ requested: 'steer', actual: 'queue' })
  })

  it('resumes a dormant chat through the normal start, or answers chat_not_resumable', async () => {
    createConversation('d1', ALLOWED, 'claude-code')
    setConversationRuntimeMode('d1', 'auto')
    ok(await delivery.sendToChat(agent(), { chat: 'd1', message: 'Wake', idempotency_key: key() }))
    expect(host.starts[0]).toMatchObject({ threadId: 'd1', provider: 'claude', cwd: ALLOWED, resumeSessionId: 'd1' })

    createConversation('d2', ALLOWED, 'codex')
    setConversationRuntimeMode('d2', 'auto')
    host.onStart = async () => {
      throw new Error('no login')
    }
    expect(
      err(await delivery.sendToChat(agent(), { chat: 'd2', message: 'Wake', idempotency_key: key() })),
    ).toMatchObject({
      code: 'chat_not_resumable',
      non_delivery_confirmed: true,
    })
    expect(host.dispatched).toHaveLength(1)
  })

  it('reaches a rotated chat by any of its ids, under its root, on the id the session runs under', async () => {
    createConversation('root1', ALLOWED, 'claude-code')
    setConversationRuntimeMode('root1', 'auto')
    recordThreadSession('uuid-rotated', 'root1')
    host.live.set('uuid-rotated', { provider: 'claude', midTurn: false, steerBlocked: false })
    const receipt = ok(
      await delivery.sendToChat(agent(), { chat: 'uuid-rotated', message: 'Hi', idempotency_key: key() }),
    )
    expect(receipt.chat.chat_id).toBe('root1')
    expect(host.dispatched[0].threadId).toBe('uuid-rotated')
    expect(getBridgeOrigin('uuid-rotated')?.conversationId).toBe('root1')
    expect(getMessagesForConversation('root1')).toHaveLength(1)
  })

  it('refuses archived chats, open hub children, a wider chat mode and a moved execution root', async () => {
    idleChat('a1')
    archiveConversation('a1')
    expect(err(await delivery.sendToChat(agent(), { chat: 'a1', message: 'x', idempotency_key: key() })).code).toBe(
      'chat_archived',
    )
    idleChat('child')
    host.openChildren.add('child')
    expect(err(await delivery.sendToChat(agent(), { chat: 'child', message: 'x', idempotency_key: key() })).code).toBe(
      'child_read_only',
    )
    idleChat('wide', 'claude', 'full-access')
    expect(err(await delivery.sendToChat(agent(), { chat: 'wide', message: 'x', idempotency_key: key() })).code).toBe(
      'mode_not_allowed',
    )
    idleChat('moved')
    setConversationWorktree('moved', OTHER, 'b')
    expect(err(await delivery.sendToChat(agent(), { chat: 'moved', message: 'x', idempotency_key: key() })).code).toBe(
      'project_not_allowed',
    )
    idleChat('own')
    expect(
      err(
        await delivery.sendToChat({ ...agent(), chatId: 'own' }, { chat: 'own', message: 'x', idempotency_key: key() }),
      ).code,
    ).toBe('policy_denied')
    expect(host.dispatched).toHaveLength(0)
  })

  it('refuses an open hub child as the caller, and keeps a rejection reason out of the answer', async () => {
    idleChat('c1')
    host.openChildren.add('caller')
    expect(err(await delivery.sendToChat(agent(), { chat: 'c1', message: 'x', idempotency_key: key() })).code).toBe(
      'child_read_only',
    )
    expect(err(await start()).code).toBe('child_read_only')
    expect(err(await delivery.stopChat(agent(), { chat: 'c1', idempotency_key: key() })).code).toBe('child_read_only')
    host.openChildren.clear()
    host.submitTurn = async () => ({
      status: 'rejected',
      accepted: false,
      duplicate: false,
      state: 'rejected',
      retryable: true,
      reason: `ENOENT ${ROOT}/secret-path`,
    })
    const refused = err(await delivery.sendToChat(agent(), { chat: 'c1', message: 'x', idempotency_key: key() }))
    expect(refused).toMatchObject({ code: 'policy_denied', non_delivery_confirmed: true })
    expect(JSON.stringify(refused)).not.toContain(ROOT)
  })

  it('leaves a pending approval open: read_chat still shows it after the send', async () => {
    idleChat('c1')
    host.live.get('c1')!.midTurn = true
    host.pending.set('c1', [
      { type: 'request.opened', threadId: 'c1', requestId: 'r1', toolName: 'Bash', detail: 'rm -rf build' },
    ] as unknown as PendingBlockingEvent[])
    ok(await delivery.sendToChat(agent(), { chat: 'c1', message: 'Go on', idempotency_key: key() }))
    const snapshot = ok(await reads.readChat({ chat: 'c1' }))
    expect('pending' in snapshot && snapshot.pending).toEqual([
      { kind: 'approval', request_id: 'r1', summary: 'Bash: rm -rf build' },
    ])
    expect('status' in snapshot && snapshot.status).toBe('waiting_for_user')
  })
})

describe('stop_chat', () => {
  it('takes back queued bridge messages only, then uses the normal Stop; allowed from plan mode', async () => {
    idleChat('c1')
    host.busyChats.add('c1')
    host.queued.set('c1', [
      { threadId: 'c1', messageId: 'remote_bridge-bcall_x', text: 'bridge', queuedAt: 1 },
      { threadId: 'c1', messageId: 'remote_owner-typed', text: 'mine', queuedAt: 2 },
    ])
    const receipt = ok(await delivery.stopChat(agent('plan'), { chat: 'c1', idempotency_key: 'stop' }))
    expect(receipt).toMatchObject({ state: 'accepted', status: 'stopping' })
    expect(host.cancelled).toEqual(['remote_bridge-bcall_x'])
    expect(host.interrupts).toEqual(['c1'])
    host.busyChats.clear()
    const replay = ok(await delivery.stopChat(agent('plan'), { chat: 'c1', idempotency_key: 'stop' }))
    expect(replay).toMatchObject({ call_id: receipt.call_id, replayed: true, status: 'stopped' })
    expect(host.interrupts).toHaveLength(1)
  })

  it('a stop that throws is stop_unconfirmed, never stopped', async () => {
    idleChat('c1')
    host.interrupt = async () => {
      throw new Error('adapter gone')
    }
    expect(err(await delivery.stopChat(agent(), { chat: 'c1', idempotency_key: key() })).code).toBe('stop_unconfirmed')
  })
})

describe('the MCP tools', () => {
  const tools = () =>
    buildBridgeTools({
      chatId: () => 'caller',
      runtimeMode: () => 'auto',
      service: reads,
      delivery,
      enabled: () => host.flag,
    })

  it('list the three mutations beside the reads and refuse with isError', async () => {
    const list = tools()
    expect(list.map((t) => t.name)).toEqual([
      'list_projects',
      'list_recent_chats',
      'search_chats',
      'read_chat',
      'start_chat',
      'send_to_chat',
      'stop_chat',
    ])
    const startTool = list.find((t) => t.name === 'start_chat')!
    expect((await startTool.call({ project: 'Raves site', message: 'x' })).isError).toBe(true)
    const done = await startTool.call({ project: 'Raves site', message: 'x', idempotency_key: 'tool' })
    expect(done.isError).toBeFalsy()
    expect(JSON.stringify(done.content)).toContain('accepted')
    host.flag = false
    const off = await startTool.call({ project: 'Raves site', message: 'x', idempotency_key: 'tool' })
    expect(off.isError).toBe(true)
    expect(JSON.stringify(off.content)).toContain('bridge_disabled')
    const badDelivery = await list
      .find((t) => t.name === 'send_to_chat')!
      .call({ chat: 'c', message: 'x', delivery: 'now', idempotency_key: 'k' })
    expect(badDelivery.isError).toBe(true)
  })
})
