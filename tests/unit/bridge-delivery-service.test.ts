/**
 * The bridge's owner delivery on a real migrated database and the real
 * durable atomic user-turn acceptance, with a fake registry host: start,
 * send and stop, idempotent replay and conflict, the mode cap, agent and
 * model choices, an agent the project stops allowing mid-call, queue and
 * steer fallback (compaction, an ACP agent),
 * dormant and rotated chats, archived and child chats, the one active
 * bridge group, stop during a start, a stop that kills the chat's measured
 * check, and a crash after the provider took the turn (the retry finds the
 * same message id and sends nothing).
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
  bridgeCheckOutcome,
  createConversation,
  getBridgeCall,
  getBridgeOrigin,
  readBridgeStopRecord,
  recordBridgeOrigin,
  writeBridgeStopRecord,
  getConversationById,
  getConversationProviderInstanceId,
  getConversationRuntimeMode,
  getDb,
  getMessagesForConversation,
  listBridgeCheckRuns,
  listBridgeProjectPolicies,
  projectBridgeCheckRun,
  recordThreadSession,
  resolveRootThreadId,
  saveBridgeProjectPolicy,
  setConversationRuntimeMode,
  setConversationWorktree,
} from '../../src/main/db/database'
import { setBridgeProjectAllowed } from '../../src/main/bridge/allowlist'
import {
  BridgeCheckService,
  setBridgeCheckService,
  type BridgeCheckProcessResult,
} from '../../src/main/bridge/check-service'
import { BridgeReadService } from '../../src/main/bridge/read-service'
import { BridgeDeliveryService, type BridgeCaller } from '../../src/main/bridge/delivery-service'
import { FakeHost } from './helpers/bridge-delivery-host'
import { buildBridgeTools } from '../../src/main/mcp/bridge-tools'
import type { PendingBlockingEvent } from '../../src/shared/pending-requests'
import { SESSION_START_STOPPED, type RuntimeMode } from '../../src/shared/provider-events'
import type { BridgeAccountView, StoredBridgeProjectPolicy } from '../../src/shared/bridge'
import type { BridgeAccountDeps } from '../../src/main/bridge/accounts'

const MACHINE = 'hub-test-machine'
const ROOT = mkdtempSync(join(tmpdir(), 'sb-bridge-delivery-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))
const ALLOWED = join(ROOT, 'allowed')
const OTHER = join(ROOT, 'other')
mkdirSync(ALLOWED, { recursive: true })
mkdirSync(OTHER, { recursive: true })

let host: FakeHost
let reads: BridgeReadService
let delivery: BridgeDeliveryService
const agent = (mode: RuntimeMode = 'full-access'): BridgeCaller => ({ kind: 'local-agent', chatId: 'caller', mode })
/** The relay's caller: no chat, no mode of its own, and the call id the relay reserved. */
const owner = (callId: string): BridgeCaller => ({ kind: 'owner', callId })

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

/** The accounts the service sees; a test rewrites the list before it starts a chat. */
let accountRows: BridgeAccountView[] = []
const pct = (used: number) => ({ used_percent: used, resets_at: '2026-11-07T18:00:00.000Z' })
const accountDeps: BridgeAccountDeps = {
  accounts: () => accountRows.map((a) => ({ id: a.account_id, name: a.name })),
  usage: async (id) => {
    const row = accountRows.find((a) => a.account_id === id)!
    const window = (kind: 'session' | 'weekly', used: number | null) => ({
      id: `${id}-${kind}`,
      label: kind,
      kind,
      usedPercent: used,
      resetsAtMs: null,
      windowMinutes: null,
      severity: 'ok' as const,
    })
    return {
      instanceId: id,
      agentType: 'claude-code',
      status: 'ok',
      plan: null,
      account: null,
      windows: [window('session', row.session.used_percent), window('weekly', row.weekly.used_percent)],
      overage: [],
      fetchedAtMs: 0,
    }
  },
}

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

/** The allowed project with one configured check, as the local check service reads it. */
function checkedPolicy(): StoredBridgeProjectPolicy {
  const [policy] = listBridgeProjectPolicies()
  return saveBridgeProjectPolicy({ ...policy, checks: [{ name: 'tests', program: 'npm', args: ['test'] }] })
}

const exited0 = (): BridgeCheckProcessResult => ({
  code: 0,
  signal: null,
  output: 'ok\n',
  bytes: 3,
  failedToStart: false,
  timedOut: false,
})

/** The real check service on the test database, with the child process as a seam. */
function checkService(
  policy: StoredBridgeProjectPolicy,
  run: (signal: AbortSignal) => Promise<BridgeCheckProcessResult>,
): BridgeCheckService {
  return new BridgeCheckService({
    enabled: () => true,
    allowed: () => [{ policy, paths: [ALLOWED], sidebarPath: ALLOWED }],
    now: () => 9_000,
    settleMs: 0,
    facts: async () => ({ head: 'c'.repeat(40), branch: 'main', tree: 'tree-1', dirty: false }),
    run: (input) => run(input.signal),
  })
}

beforeEach(() => {
  createMigratedDb()
  setBridgeCheckService(null)
  host = new FakeHost(MACHINE)
  reads = new BridgeReadService({
    machineId: () => MACHINE,
    live: { status: () => null, busy: (id) => host.busy(id), pending: (id) => host.pending.get(id) ?? [] },
    agentAvailable: (agent) => host.agentAvailable(agent),
  })
  accountRows = [
    { account_id: 'claude-work', name: 'Work', usage: 'ok', session: pct(95), weekly: pct(10) },
    { account_id: 'claude-home', name: 'Home laptop', usage: 'ok', session: pct(20), weekly: pct(60) },
  ]
  delivery = new BridgeDeliveryService(host, reads, Date.now, { stopConfirmMs: 300, stopPollMs: 5 }, accountDeps)
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
    // A resume after a restart starts on the same account.
    expect(getConversationProviderInstanceId(receipt.chat.chat_id)).toBe('claude-code-work')
  })

  it('records the baseline before the turn can write it, never beside it', async () => {
    const order: string[] = []
    setBridgeCheckService(
      new BridgeCheckService({
        enabled: () => true,
        allowed: () => [],
        now: () => 7_000,
        facts: async () => {
          // A snapshot of a big checkout takes a while; the turn must wait for it.
          await new Promise((done) => setTimeout(done, 5))
          order.push('baseline')
          return { head: 'c'.repeat(40), branch: 'main', tree: 'tree-1', dirty: false }
        },
      }),
    )
    host.onStart = async (opts) => {
      order.push('session')
      host.live.set(opts.threadId, { provider: opts.provider, midTurn: false, steerBlocked: false })
    }
    const receipt = ok(await start())
    setBridgeCheckService(null)
    expect(order).toEqual(['baseline', 'session'])
    expect(getBridgeOrigin(receipt.chat.chat_id)).toMatchObject({ baselineTree: 'tree-1', baselineAt: 7_000 })
    expect(host.dispatched).toHaveLength(1)
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
    const other = ok(await delivery.startChat({ kind: 'local-agent', chatId: 'caller-2', mode: 'full-access' }, args))
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
    // gemini is allowed but cannot start here, so it is not offered.
    expect(err(await start({ agent: 'opencode' }))).toMatchObject({
      code: 'agent_unavailable',
      agent_choices: ['claude-code', 'codex'],
    })
    expect(err(await start({ agent: 'gemini' }))).toMatchObject({ code: 'agent_unavailable' })
    const model = err(await start({ agent: 'codex', model: 'gpt-0' }))
    expect(model.code).toBe('agent_unavailable')
    expect(model.model_choices).toContain('gpt-5.5')
    expect(host.starts).toHaveLength(0)
    expect(ok(await start({ agent: 'codex', model: 'gpt-5.5' }))).toMatchObject({ agent: 'codex', model: 'gpt-5.5' })
  })

  it('does not use a policy default model made for another agent', async () => {
    const [policy] = listBridgeProjectPolicies()
    saveBridgeProjectPolicy({ ...policy, default_model: 'gpt-5.5' })
    expect(ok(await start()).model).toBeNull()
    expect(ok(await start({ agent: 'codex' })).model).toBe('gpt-5.5')
  })

  it('checks the flag and the allowlist again after the start awaited', async () => {
    host.onStart = async (opts) => {
      host.live.set(opts.threadId, { provider: opts.provider, midTurn: false, steerBlocked: false })
      host.flag = false
    }
    expect(err(await start())).toMatchObject({ code: 'bridge_disabled', non_delivery_confirmed: true })
    host.flag = true
    host.onStart = async (opts) => {
      host.live.set(opts.threadId, { provider: opts.provider, midTurn: false, steerBlocked: false })
      setBridgeProjectAllowed(ALLOWED, false, MACHINE)
    }
    expect(err(await start())).toMatchObject({ code: 'project_not_allowed', non_delivery_confirmed: true })
    expect(host.dispatched).toHaveLength(0)
  })

  it('reads the allowed agents again after the availability probe and after the start', async () => {
    const narrow = () => {
      const [policy] = listBridgeProjectPolicies()
      saveBridgeProjectPolicy({ ...policy, allowed_agents: ['codex'] })
    }
    // The owner unchecks claude-code while the availability probe is awaited.
    host.agentAvailable = async (a) => {
      narrow()
      return a !== 'gemini'
    }
    expect(err(await start())).toMatchObject({ code: 'agent_unavailable', agent_choices: ['codex'] })
    expect(host.starts).toHaveLength(0)

    host.agentAvailable = async (a) => a !== 'gemini'
    const [policy] = listBridgeProjectPolicies()
    saveBridgeProjectPolicy({ ...policy, allowed_agents: ['claude-code', 'codex'] })
    // And while the session starts, before the first turn goes in.
    host.onStart = async (opts) => {
      host.live.set(opts.threadId, { provider: opts.provider, midTurn: false, steerBlocked: false })
      narrow()
    }
    expect(err(await start())).toMatchObject({ code: 'agent_unavailable', non_delivery_confirmed: true })
    expect(host.dispatched).toHaveLength(0)
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
    // As the registry does: a Stop during the start makes the start end with SESSION_START_STOPPED.
    host.interrupt = async (threadId) => {
      host.interrupts.push(threadId)
      if (host.startingThreads.has(threadId)) release()
    }
    const starting = start()
    await vi.waitFor(() => expect(host.starts).toHaveLength(1))
    const chatId = host.starts[0].threadId
    const stopped = ok(await delivery.stopChat(agent(), { chat: chatId, idempotency_key: key() }))
    expect(stopped).toMatchObject({ state: 'accepted', status: 'stopped' })
    expect(host.interrupts).toEqual([chatId])
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

describe('start_chat picks an account', () => {
  it('takes the account with the most room, names it and starts the session on it', async () => {
    const receipt = ok(await start())
    expect(receipt.account).toEqual({ account_id: 'claude-home', name: 'Home laptop' })
    expect(host.starts.at(-1)?.instanceId).toBe('claude-home')
  })

  it('takes the most weekly room once every five-hour window is busy', async () => {
    accountRows = [
      { account_id: 'claude-work', name: 'Work', usage: 'ok', session: pct(99), weekly: pct(70) },
      { account_id: 'claude-home', name: 'Home laptop', usage: 'ok', session: pct(95), weekly: pct(20) },
    ]
    expect(ok(await start()).account?.account_id).toBe('claude-home')
  })

  it('honours an account named by id or by the name the owner gave it', async () => {
    expect(ok(await start({ account: 'claude-work' })).account?.account_id).toBe('claude-work')
    expect(ok(await start({ account: 'Work' })).account?.account_id).toBe('claude-work')
    expect(ok(await start({ account: 'home laptop' })).account?.account_id).toBe('claude-home')
  })

  it('refuses an account name nothing has, and lists what the agent does have', async () => {
    const error = err(await start({ account: 'office mac' }))
    expect(error.code).toBe('agent_unavailable')
    expect(error.account_choices).toEqual([
      { account_id: 'claude-work', name: 'Work' },
      { account_id: 'claude-home', name: 'Home laptop' },
    ])
    expect(host.starts).toHaveLength(0)
  })

  it('refuses a name that matches two accounts rather than guessing', async () => {
    accountRows = [
      { account_id: 'a1', name: 'Work main', usage: 'ok', session: pct(10), weekly: pct(10) },
      { account_id: 'a2', name: 'Work spare', usage: 'ok', session: pct(10), weekly: pct(10) },
    ]
    expect(err(await start({ account: 'work' })).code).toBe('ambiguous_target')
  })

  it('starts with no account when the agent has none, as it did before', async () => {
    accountRows = []
    const receipt = ok(await start())
    expect(receipt.account).toBeNull()
    expect(host.starts.at(-1)?.instanceId).toBeUndefined()
  })

  it('answers a replay with the account it used', async () => {
    const first = ok(await start({ idempotency_key: 'same' }))
    const replay = ok(await start({ idempotency_key: 'same' }))
    expect(replay.account).toEqual(first.account)
    expect(replay.replayed).toBe(true)
  })
})

describe('the mode cap refusal', () => {
  it('names the chat mode, the project cap and where the owner changes it', async () => {
    const [policy] = listBridgeProjectPolicies()
    saveBridgeProjectPolicy({ ...policy, allowed_agents: ['claude-code'], maximum_mode: 'auto' })
    idleChat('wide', 'claude', 'full-access')
    const error = err(
      await delivery.sendToChat(owner('relay-wide'), { chat: 'wide', message: 'hi', idempotency_key: 'relay-wide' }),
    )
    expect(error.code).toBe('mode_not_allowed')
    expect(error.message).toBe(
      'This chat runs in Full access. The bridge may drive chats in this project up to Auto. ' +
        'Change Highest mode for Raves site in Settings > Labs, or start a new chat.',
    )
  })

  it('lets the bridge into a full-access chat once the project allows it', async () => {
    const [policy] = listBridgeProjectPolicies()
    saveBridgeProjectPolicy({ ...policy, allowed_agents: ['claude-code'], maximum_mode: 'full-access' })
    idleChat('wide2', 'claude', 'full-access')
    const sent = ok(
      await delivery.sendToChat(owner('relay-wide2'), { chat: 'wide2', message: 'hi', idempotency_key: 'r2' }),
    )
    expect(sent.state).toBe('accepted')
  })

  it('names the mode a start asked for when it is wider than the project allows', async () => {
    const error = err(await start({ mode: 'full-access' }))
    expect(error.code).toBe('mode_not_allowed')
    expect(error.message).toBe(
      'Full access is wider than this project allows. The bridge may start chats in this project up to Auto. ' +
        'Change Highest mode for Raves site in Settings > Labs.',
    )
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

  it('stamps each origin with the source of its caller, which is what the control lease stops', async () => {
    idleChat('c1')
    ok(await delivery.sendToChat(agent(), { chat: 'c1', message: 'Next', idempotency_key: key() }))
    expect(getBridgeOrigin('c1')?.source).toBe('local')
    const started = ok(await start({ idempotency_key: 'oc1' }, owner('bcall_oc1')))
    expect(getBridgeOrigin(started.chat.chat_id)?.source).toBe('relay')
    expect(started.call_id).toBe('bcall_oc1')
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

  it('refuses a chat archived during its resume, and never starts a dormant chat outside the root', async () => {
    createConversation('d1', ALLOWED, 'claude-code')
    setConversationRuntimeMode('d1', 'auto')
    host.onStart = async (opts) => {
      host.live.set(opts.threadId, { provider: 'claude', midTurn: false, steerBlocked: false })
      archiveConversation('d1')
    }
    expect(err(await delivery.sendToChat(agent(), { chat: 'd1', message: 'x', idempotency_key: key() })).code).toBe(
      'chat_archived',
    )
    host.onStart = null
    createConversation('d2', ALLOWED, 'claude-code')
    setConversationRuntimeMode('d2', 'auto')
    setConversationWorktree('d2', OTHER, 'b')
    expect(err(await delivery.sendToChat(agent(), { chat: 'd2', message: 'x', idempotency_key: key() })).code).toBe(
      'project_not_allowed',
    )
    expect(host.starts.map((o) => o.threadId)).toEqual(['d1'])
    expect(host.dispatched).toHaveLength(0)
  })

  it('reports queue when the registry queued the message after all', async () => {
    idleChat('c1')
    const submit = host.submitTurn
    host.submitTurn = async (input) => {
      const result = await submit(input)
      host.queued.set('c1', [{ threadId: 'c1', messageId: `remote_${input.origin}`, text: 'x', queuedAt: 1 }])
      return result
    }
    const receipt = ok(await delivery.sendToChat(agent(), { chat: 'c1', message: 'x', idempotency_key: key() }))
    expect(receipt.delivery).toEqual({ requested: 'queue', actual: 'queue' })
  })

  it('a send replayed after a crash keeps its delivery', async () => {
    idleChat('c1')
    host.dieAfterDispatch = true
    const args = { chat: 'c1', message: 'x', idempotency_key: 'send-crash' }
    expect(err(await delivery.sendToChat(agent(), args)).code).toBe('delivery_unknown')
    const replay = ok(await new BridgeDeliveryService(host, reads).sendToChat(agent(), args))
    expect(replay).toMatchObject({ state: 'accepted', delivery: { requested: 'queue', actual: 'turn' } })
  })

  it('a stop that races an unconfirmed send takes its queued message back', async () => {
    idleChat('c1')
    host.submitTurn = async (input) => {
      // The stop arrives while the turn is being handed over; the message ends up queued, the answer lost.
      void delivery.stopChat(agent(), { chat: 'c1', idempotency_key: key() })
      host.queued.set('c1', [{ threadId: 'c1', messageId: `remote_${input.origin}`, text: 'x', queuedAt: 1 }])
      throw new Error('backend died')
    }
    const lost = err(await delivery.sendToChat(agent(), { chat: 'c1', message: 'x', idempotency_key: key() }))
    expect(lost.code).toBe('delivery_unknown')
    expect(host.cancelled).toContain(`remote_bridge-${lost.call_id}`)
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

  it('refuses a chat whose agent the project does not allow, before the resume and after it', async () => {
    const [policy] = listBridgeProjectPolicies()
    saveBridgeProjectPolicy({ ...policy, allowed_agents: ['codex'] })
    idleChat('c1')
    expect(err(await delivery.sendToChat(agent(), { chat: 'c1', message: 'x', idempotency_key: key() }))).toMatchObject(
      {
        code: 'agent_unavailable',
        agent_choices: ['codex'],
      },
    )
    expect(host.starts).toHaveLength(0)

    // Allowed when the resume starts, taken off the project while it runs.
    saveBridgeProjectPolicy({ ...policy, allowed_agents: ['claude-code', 'codex'] })
    createConversation('d1', ALLOWED, 'claude-code')
    setConversationRuntimeMode('d1', 'auto')
    host.onStart = async (opts) => {
      host.live.set(opts.threadId, { provider: 'claude', midTurn: false, steerBlocked: false })
      saveBridgeProjectPolicy({ ...policy, allowed_agents: ['codex'] })
    }
    expect(err(await delivery.sendToChat(agent(), { chat: 'd1', message: 'x', idempotency_key: key() }))).toMatchObject(
      {
        code: 'agent_unavailable',
        non_delivery_confirmed: true,
      },
    )
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
    expect(receipt).toMatchObject({ state: 'accepted', status: 'stopped' })
    expect(host.cancelled).toEqual(['remote_bridge-bcall_x'])
    expect(host.interrupts).toEqual(['c1'])
    const replay = ok(await delivery.stopChat(agent('plan'), { chat: 'c1', idempotency_key: 'stop' }))
    expect(replay).toMatchObject({ call_id: receipt.call_id, replayed: true, status: 'stopped' })
    expect(host.interrupts).toHaveLength(1)
  })

  it('a stop right after a start keeps stopping until the provider takes the turn, then answers stopped', async () => {
    const started = ok(await start())
    const chatId = started.chat.chat_id
    // The turn counts as running, but the provider has not taken it: a Stop does nothing yet.
    host.busyChats.add(chatId)
    host.interruptLands = false
    setTimeout(() => {
      host.interruptLands = true
    }, 40)
    const stopped = ok(await delivery.stopChat(agent(), { chat: chatId, idempotency_key: key() }))
    expect(stopped.status).toBe('stopped')
    expect(host.interrupts.length).toBeGreaterThan(1)
    expect(host.busy(chatId)).toBe(false)
  })

  it('a stop the provider never takes is stop_unconfirmed, not stopping', async () => {
    idleChat('c1')
    host.busyChats.add('c1')
    host.interruptLands = false
    const refused = err(await delivery.stopChat(agent(), { chat: 'c1', idempotency_key: key() }))
    expect(refused.code).toBe('stop_unconfirmed')
  })

  it("is not held up by the owner's own messages held in the queue", async () => {
    idleChat('c1')
    host.heldOnly.add('c1')
    expect(ok(await delivery.stopChat(agent(), { chat: 'c1', idempotency_key: key() })).status).toBe('stopped')
  })

  it('takes back a bridge message queued during the stop, and is unconfirmed when one cannot be taken back', async () => {
    idleChat('c1')
    host.busyChats.add('c1')
    host.interruptLands = false
    setTimeout(() => {
      host.queued.set('c1', [{ threadId: 'c1', messageId: 'remote_bridge-late', text: 'x', queuedAt: 1 }])
      host.interruptLands = true
    }, 20)
    expect(ok(await delivery.stopChat(agent(), { chat: 'c1', idempotency_key: key() })).status).toBe('stopped')
    expect(host.cancelled).toContain('remote_bridge-late')

    host.cancelQueuedTurn = async () => ({ ok: false as const, reason: 'unsupported' as const, message: 'no' })
    host.queued.set('c1', [{ threadId: 'c1', messageId: 'remote_bridge-stuck', text: 'x', queuedAt: 1 }])
    expect(err(await delivery.stopChat(agent(), { chat: 'c1', idempotency_key: key() })).code).toBe('stop_unconfirmed')
  })

  it("kills the chat's running check, records it cancelled, and never lets it report a pass", async () => {
    idleChat('c1')
    const policy = checkedPolicy()
    recordBridgeOrigin({
      conversationId: 'c1',
      callId: 'bcall_1',
      projectId: policy.project_id,
      machineId: MACHINE,
      policyRevision: policy.revision,
      source: 'relay',
    })
    let childStarted = () => {}
    const started = new Promise<void>((done) => {
      childStarted = done
    })
    const checks = checkService(policy, (signal) => {
      childStarted()
      // A long check: the child ends only when the stop kills it, and it would
      // have exited 0 either way.
      return new Promise((done) => signal.addEventListener('abort', () => done(exited0()), { once: true }))
    })
    setBridgeCheckService(checks)
    const scheduled = checks.onTurnEnded('c1')
    await started
    expect(listBridgeCheckRuns('c1')[0].state).toBe('running')

    expect(ok(await delivery.stopChat(agent(), { chat: 'c1', idempotency_key: key() })).status).toBe('stopped')
    await scheduled
    const [recorded] = listBridgeCheckRuns('c1')
    expect(recorded).toMatchObject({ state: 'cancelled', exitCode: null })
    // The one rule every surface reads a run by: no measurement, and no pass.
    expect(bridgeCheckOutcome(recorded)).toBe('not_run')
    expect(projectBridgeCheckRun(recorded, recorded.treeBefore).status).toBe('not_measured')
  })

  it('leaves a chat with no running check exactly as it was, and records no run', async () => {
    idleChat('c1')
    host.busyChats.add('c1')
    const policy = checkedPolicy()
    setBridgeCheckService(checkService(policy, () => Promise.resolve(exited0())))
    expect(ok(await delivery.stopChat(agent(), { chat: 'c1', idempotency_key: key() })).status).toBe('stopped')
    expect(host.interrupts).toEqual(['c1'])
    expect(listBridgeCheckRuns('c1')).toEqual([])
  })

  it('is stop_unconfirmed when a running check cannot be recorded as cancelled', async () => {
    idleChat('c1')
    const policy = checkedPolicy()
    recordBridgeOrigin({
      conversationId: 'c1',
      callId: 'bcall_2',
      projectId: policy.project_id,
      machineId: MACHINE,
      policyRevision: policy.revision,
      source: 'relay',
    })
    // The child was killed but its row could not be written, so the run is no
    // longer accounted for: the answer must not claim the chat was stopped.
    setBridgeCheckService({ cancel: () => false } as unknown as BridgeCheckService)
    expect(err(await delivery.stopChat(agent(), { chat: 'c1', idempotency_key: key() })).code).toBe('stop_unconfirmed')
    expect(getBridgeOrigin('c1')?.stopState).toBe('unconfirmed')
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
      'list_agents',
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

describe('stops of all bridge work', () => {
  const kill = () =>
    writeBridgeStopRecord({ generation: readBridgeStopRecord().generation + 1, killed: true, killPending: false })

  function bridgeChat(id: string, source: 'local' | 'relay' = 'local') {
    idleChat(id)
    recordBridgeOrigin({
      conversationId: id,
      callId: `bcall_${id}`,
      projectId: 'p',
      machineId: MACHINE,
      policyRevision: 1,
      source,
    })
  }

  it('while killed refuses start_chat and send_to_chat with confirmed non-delivery, but reads and stop_chat work', async () => {
    bridgeChat('c1')
    kill()
    const refused = err(await start())
    expect(refused).toMatchObject({ code: 'killed', non_delivery_confirmed: true, retry: 'ask_owner' })
    expect(err(await delivery.sendToChat(agent(), { chat: 'c1', message: 'x', idempotency_key: key() }))).toMatchObject(
      {
        code: 'killed',
        non_delivery_confirmed: true,
      },
    )
    expect(host.starts).toEqual([])
    expect(host.dispatched).toEqual([])
    expect(ok(reads.listProjects()).projects).toHaveLength(1)
    expect((await reads.readChat({ chat: 'c1' })).ok).toBe(true)
    host.busyChats.add('c1')
    expect(ok(await delivery.stopChat(agent(), { chat: 'c1', idempotency_key: key() })).status).toBe('stopped')
  })

  it('a kill during a start fences it: the turn is never sent and the call is rejected as killed', async () => {
    host.onStart = async (opts) => {
      kill()
      host.live.set(opts.threadId, { provider: opts.provider, midTurn: false, steerBlocked: false })
    }
    const refused = err(await start())
    expect(refused).toMatchObject({ code: 'killed', non_delivery_confirmed: true })
    expect(host.dispatched).toEqual([])
    expect(getBridgeCall(String(refused.call_id))?.state).toBe('rejected')
  })

  it('stops every active bridge chat, and only those: an unrelated busy chat is untouched', async () => {
    bridgeChat('b1')
    bridgeChat('b2')
    bridgeChat('idle')
    idleChat('mine')
    host.busyChats.add('b1')
    host.busyChats.add('mine')
    host.queued.set('b2', [{ threadId: 'b2', messageId: 'remote_bridge-bcall_q', text: 'x', queuedAt: 1 }])
    expect(delivery.activeGroups().sort()).toEqual(['b1', 'b2'])
    const result = await delivery.stopGroups()
    expect(result).toEqual({ stopped: ['b1', 'b2'], unconfirmed: [] })
    expect(host.interrupts.sort()).toEqual(['b1', 'b2'])
    expect(host.cancelled).toEqual(['remote_bridge-bcall_q'])
    expect(host.busy('mine')).toBe(true)
    expect(getBridgeOrigin('b1')?.stopState).toBe('stopped')
    expect(getBridgeOrigin('idle')?.stopState).toBeNull()
  })

  it('stops a turn the owner started when the bridge steered into it, and reports one it cannot stop as unconfirmed', async () => {
    // The owner's turn runs in a chat the bridge sent into: the chat counts as busy.
    bridgeChat('steered')
    host.busyChats.add('steered')
    expect((await delivery.stopGroups()).stopped).toEqual(['steered'])
    expect(host.busy('steered')).toBe(false)

    host.busyChats.add('steered')
    host.interruptLands = false
    expect(await delivery.stopGroups()).toEqual({ stopped: [], unconfirmed: ['steered'] })
    expect(getBridgeOrigin('steered')?.stopState).toBe('unconfirmed')
  })

  it('stops only relay-started work when asked for that source', async () => {
    bridgeChat('local')
    bridgeChat('relay', 'relay')
    host.busyChats.add('local')
    host.busyChats.add('relay')
    expect(delivery.activeGroups(['relay'])).toEqual(['relay'])
    expect((await delivery.stopGroups(['relay'])).stopped).toEqual(['relay'])
    expect(host.busy('local')).toBe(true)
  })
})
