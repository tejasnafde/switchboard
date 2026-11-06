/**
 * The relay's `command` frames on this desktop: the frame shape and the wire
 * version, a full owner call for each of the seven tools, the owner's
 * authority (the project policy alone, no calling chat and no plan-mode or
 * chat-scoped rule of a local agent), a denied project and a denied mode,
 * fuzzy ambiguity, a project the owner took off the allowlist, a moved
 * execution root, the kill, the flag, the stop generation (including a stop
 * that is still running and one that lands while a call waits), a command
 * that arrives while this app quits, duplicate
 * mutations across a relay retry and a restart of this desktop, and that a
 * chat the relay started is an ordinary chat in the sidebar with its
 * bridge-origin label.
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
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
  bridgeOriginMarkers,
  createConversation,
  getBridgeCall,
  getBridgeOrigin,
  getManagedRootConversationsForProjects,
  getMessagesForConversation,
  listBridgeProjectPolicies,
  saveBridgeProjectPolicy,
  setConversationRuntimeMode,
  setConversationWorktree,
  writeBridgeStopRecord,
} from '../../src/main/db/database'
import { setBridgeProjectAllowed } from '../../src/main/bridge/allowlist'
import { BridgeReadService } from '../../src/main/bridge/read-service'
import { BridgeDeliveryService } from '../../src/main/bridge/delivery-service'
import {
  BridgeCommandDispatcher,
  parseBridgeCommand,
  type BridgeCommandAnswer,
} from '../../src/main/bridge/command-dispatch'
import { bridgeOriginLabel, parseBridgeOriginMarker, withBridgeOrigins } from '../../src/shared/bridge'
import { FakeHost } from './helpers/bridge-delivery-host'

const MACHINE = 'hub-test-machine'
const ROOT = mkdtempSync(join(tmpdir(), 'sb-bridge-command-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))
const ALLOWED = join(ROOT, 'allowed')
const OTHER = join(ROOT, 'other')
mkdirSync(ALLOWED, { recursive: true })
mkdirSync(OTHER, { recursive: true })

let host: FakeHost
let reads: BridgeReadService
let delivery: BridgeDeliveryService
let dispatcher: BridgeCommandDispatcher
let flag: boolean
let quitting: boolean
let applied: number[]
/** Every generation a command put on the stop queue, newer or not. */
let queued: number[]
/** Runs inside the stop queue, as a stop that was already running would. */
let onStopQueue: (() => Promise<void>) | null

function build(): void {
  reads = new BridgeReadService({
    machineId: () => MACHINE,
    live: { status: () => null, busy: (id) => host.busy(id), pending: (id) => host.pending.get(id) ?? [] },
  })
  delivery = new BridgeDeliveryService(host, reads, Date.now, { stopConfirmMs: 300, stopPollMs: 5 })
  dispatcher = new BridgeCommandDispatcher({
    enabled: () => flag,
    quitting: () => quitting,
    reads,
    delivery,
    stopGeneration: () => generation,
    // As the stop service does: a generation that is not newer records and
    // stops nothing, but the call still waits on its queue.
    advanceStopGeneration: async (next) => {
      queued.push(next)
      if (onStopQueue) await onStopQueue()
      if (next <= generation) return
      applied.push(next)
      generation = next
    },
  })
}

let generation = 0
let callSeq = 0

/** One frame as the relay sends it: the target is already resolved and the limit already clamped. */
function frame(tool: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  callSeq += 1
  return {
    type: 'command',
    wire_version: 1,
    machine_id: MACHINE,
    connection_generation: 1,
    call_id: `relay_call_${callSeq}`,
    tool,
    target: null,
    arguments: args,
    input_hash: null,
    stop_generation: generation,
    sent_at: new Date().toISOString(),
    respond_by: new Date(Date.now() + 30_000).toISOString(),
    ...extra,
  }
}

const run = async (f: Record<string, unknown>): Promise<BridgeCommandAnswer> => {
  const answer = await dispatcher.run(f)
  if (!answer) throw new Error('the frame was dropped')
  return answer
}
const ok = async (f: Record<string, unknown>) => {
  const answer = await run(f)
  if (!answer.ok) throw new Error(JSON.stringify(answer.error))
  return answer.result as Record<string, unknown>
}
const bad = async (f: Record<string, unknown>) => {
  const answer = await run(f)
  if (answer.ok) throw new Error(`expected an error, got ${JSON.stringify(answer.result)}`)
  return answer.error!
}

function idleChat(id: string, title = 'Header work') {
  createConversation(id, ALLOWED, 'claude-code', title)
  setConversationRuntimeMode(id, 'auto')
  host.live.set(id, { provider: 'claude', midTurn: false, steerBlocked: false })
}

beforeEach(() => {
  createMigratedDb()
  host = new FakeHost(MACHINE)
  flag = true
  quitting = false
  generation = 0
  applied = []
  queued = []
  onStopQueue = null
  callSeq = 0
  build()
  addProject(ALLOWED, 'Raves site')
  addProject(OTHER, 'Other')
  setBridgeProjectAllowed(ALLOWED, true, MACHINE)
  const [policy] = listBridgeProjectPolicies()
  saveBridgeProjectPolicy({ ...policy, allowed_agents: ['claude-code', 'codex'] })
})

describe('frame shape', () => {
  it('needs a call id, this wire version, a known tool, object arguments and a stop generation', async () => {
    expect(parseBridgeCommand({ ...frame('read_chat'), call_id: '' }).ok).toBe(false)
    expect(await dispatcher.run({ ...frame('read_chat'), call_id: 42 })).toBeNull()
    expect(await bad({ ...frame('read_chat'), wire_version: 2 })).toMatchObject({ code: 'unsupported_version' })
    expect(await bad(frame('run_shell'))).toMatchObject({ code: 'invalid_request' })
    expect(await bad({ ...frame('read_chat'), arguments: [] })).toMatchObject({ code: 'invalid_request' })
    expect(await bad({ ...frame('read_chat'), stop_generation: -1 })).toMatchObject({ code: 'invalid_request' })
    expect(await bad(frame('search_chats'))).toMatchObject({ code: 'invalid_request' })
    expect(await bad(frame('start_chat', { project: 'Raves site' }))).toMatchObject({ code: 'invalid_request' })
  })

  it('refuses every tool with the flag off and never reaches a provider', async () => {
    idleChat('c1')
    flag = false
    for (const f of [
      frame('list_projects'),
      frame('list_recent_chats'),
      frame('search_chats', { query: 'header' }),
      frame('read_chat', { chat: { machine_id: MACHINE, chat_id: 'c1' } }),
      frame('start_chat', { project: 'Raves site', message: 'Go' }),
      frame('send_to_chat', { chat: { machine_id: MACHINE, chat_id: 'c1' }, message: 'Go' }),
      frame('stop_chat', { chat: { machine_id: MACHINE, chat_id: 'c1' } }),
    ])
      expect(await bad(f)).toMatchObject({ code: 'bridge_disabled', delivered: false, non_delivery_confirmed: true })
    expect(host.dispatched).toHaveLength(0)
    expect(host.interrupts).toHaveLength(0)
  })

  it('refuses every tool once this app is quitting, so no session starts after the teardown', async () => {
    idleChat('c1')
    quitting = true
    for (const f of [
      frame('read_chat', { chat: { machine_id: MACHINE, chat_id: 'c1' } }),
      frame('start_chat', { project: 'Raves site', message: 'Go' }),
      frame('send_to_chat', { chat: { machine_id: MACHINE, chat_id: 'c1' }, message: 'Go' }),
      frame('stop_chat', { chat: { machine_id: MACHINE, chat_id: 'c1' } }),
    ])
      expect(await bad(f)).toMatchObject({
        code: 'machine_offline',
        retry: 'same_key',
        non_delivery_confirmed: true,
      })
    expect(host.starts).toHaveLength(0)
    expect(host.dispatched).toHaveLength(0)
  })
})

describe('a full owner call for each tool', () => {
  it('answers all seven on an allowed target', async () => {
    const projects = await ok(frame('list_projects'))
    expect(projects.projects).toMatchObject([{ label: 'Raves site', machine_id: MACHINE, maximum_mode: 'auto' }])
    expect(JSON.stringify(projects)).not.toContain(ALLOWED)

    const started = await ok(frame('start_chat', { project: 'Raves site', message: 'Fix the header' }))
    const chat = started.chat as { machine_id: string; chat_id: string }
    expect(started).toMatchObject({ state: 'accepted', replayed: false, agent: 'claude-code', mode: 'auto' })
    expect(host.dispatched).toHaveLength(1)

    const sent = await ok(frame('send_to_chat', { chat, message: 'And the footer' }))
    expect(sent).toMatchObject({ state: 'accepted', delivery: { requested: 'queue', actual: 'turn' } })

    const read = await ok(frame('read_chat', { chat }))
    expect(read).toMatchObject({ chat, status: 'idle', archived: false })
    expect((read.history as Array<{ text: string }>).map((m) => m.text)).toEqual(['Fix the header', 'And the footer'])

    const recent = await ok(frame('list_recent_chats', { limit: 20 }))
    expect((recent.chats as Array<{ chat: { chat_id: string } }>).map((c) => c.chat.chat_id)).toContain(chat.chat_id)

    const found = await ok(frame('search_chats', { query: 'footer', limit: 20 }))
    expect((found.chats as Array<{ chat: { chat_id: string } }>)[0].chat.chat_id).toBe(chat.chat_id)

    const stopped = await ok(frame('stop_chat', { chat }))
    expect(stopped).toMatchObject({ state: 'accepted', status: 'stopped' })
    expect(host.interrupts).toContain(chat.chat_id)
  })

  it('records the relay call id and keeps the call receipt under it', async () => {
    const f = frame('start_chat', { project: 'Raves site', message: 'Fix the header' })
    const started = await ok(f)
    expect(started.call_id).toBe(f.call_id)
    const stored = getBridgeCall(f.call_id)
    expect(stored).toMatchObject({ state: 'accepted', idempotencyKey: `relay:${f.call_id}`, machineId: MACHINE })
  })
})

describe('the owner is not a local agent', () => {
  it('is capped by the project policy alone and never by a calling chat', async () => {
    const [policy] = listBridgeProjectPolicies()
    saveBridgeProjectPolicy({ ...policy, maximum_mode: 'full-access' })
    // No caller mode narrows this: the project allows full access, so the owner may ask for it.
    const started = await ok(frame('start_chat', { project: 'Raves site', message: 'Go', mode: 'full-access' }))
    expect(started).toMatchObject({ mode: 'full-access' })
  })

  it('refuses a mode above the project cap instead of lowering it', async () => {
    expect(await bad(frame('start_chat', { project: 'Raves site', message: 'Go', mode: 'full-access' }))).toMatchObject(
      { code: 'mode_not_allowed', non_delivery_confirmed: true },
    )
    expect(host.dispatched).toHaveLength(0)
  })

  it('messages a chat that a hub owns no more than a local agent does', async () => {
    idleChat('c1')
    host.openChildren.add('c1')
    expect(
      await bad(frame('send_to_chat', { chat: { machine_id: MACHINE, chat_id: 'c1' }, message: 'Go' })),
    ).toMatchObject({ code: 'child_read_only' })
  })
})

describe('targets the desktop refuses', () => {
  it('refuses a project the owner never allowed and one taken off the allowlist', async () => {
    expect(await bad(frame('start_chat', { project: 'Other', message: 'Go' }))).toMatchObject({
      code: 'project_not_allowed',
    })
    setBridgeProjectAllowed(ALLOWED, false, MACHINE)
    expect(await bad(frame('start_chat', { project: 'Raves site', message: 'Go' }))).toMatchObject({
      code: 'project_not_allowed',
      non_delivery_confirmed: true,
    })
    expect(host.starts).toHaveLength(0)
  })

  it('answers ambiguous_target with choices when a name matches two allowed projects', async () => {
    const twin = join(ROOT, 'raves-site-home')
    mkdirSync(twin, { recursive: true })
    addProject(twin, 'Raves site home')
    setBridgeProjectAllowed(twin, true, MACHINE)
    const error = await bad(frame('start_chat', { project: 'raves', message: 'Go' }))
    expect(error).toMatchObject({ code: 'ambiguous_target' })
    expect((error.choices as Array<{ label: string }>).map((c) => c.label).sort()).toEqual([
      'Raves site',
      'Raves site home',
    ])
    expect(host.starts).toHaveLength(0)
  })

  it('refuses a chat whose execution root moved out of the allowed folder', async () => {
    idleChat('c1')
    const moved = join(ROOT, 'moved-worktree')
    mkdirSync(moved, { recursive: true })
    setConversationWorktree('c1', moved, 'feat/x')
    expect(
      await bad(frame('send_to_chat', { chat: { machine_id: MACHINE, chat_id: 'c1' }, message: 'Go' })),
    ).toMatchObject({ code: 'project_not_allowed' })
    expect(host.dispatched).toHaveLength(0)
  })

  it('refuses when the allowed folder itself no longer resolves', async () => {
    const gone = join(ROOT, 'gone')
    mkdirSync(gone, { recursive: true })
    addProject(gone, 'Gone')
    setBridgeProjectAllowed(gone, true, MACHINE)
    renameSync(gone, join(ROOT, 'gone-renamed'))
    expect(await bad(frame('start_chat', { project: 'Gone', message: 'Go' }))).toMatchObject({
      code: 'project_not_allowed',
    })
    expect(host.starts).toHaveLength(0)
  })
})

describe('the kill and the stop generation', () => {
  it('refuses a mutation while bridge work is killed, and still reads and stops', async () => {
    idleChat('c1')
    host.busyChats.add('c1')
    writeBridgeStopRecord({ generation: 2, killed: true, killPending: false })
    generation = 2
    for (const f of [
      frame('start_chat', { project: 'Raves site', message: 'Go' }),
      frame('send_to_chat', { chat: { machine_id: MACHINE, chat_id: 'c1' }, message: 'Go' }),
    ])
      expect(await bad(f)).toMatchObject({ code: 'killed', delivered: false, non_delivery_confirmed: true })
    expect(host.dispatched).toHaveLength(0)
    expect(await ok(frame('read_chat', { chat: { machine_id: MACHINE, chat_id: 'c1' } }))).toMatchObject({
      status: 'running',
    })
    expect(await ok(frame('stop_chat', { chat: { machine_id: MACHINE, chat_id: 'c1' } }))).toMatchObject({
      status: 'stopped',
    })
  })

  it('fences a mutation the relay resolved before a stop this desktop applied', async () => {
    idleChat('c1')
    generation = 3
    for (const f of [
      frame('start_chat', { project: 'Raves site', message: 'Go' }),
      frame('send_to_chat', { chat: { machine_id: MACHINE, chat_id: 'c1' }, message: 'Go' }),
    ])
      expect(await bad({ ...f, stop_generation: 2 })).toMatchObject({
        code: 'policy_denied',
        delivered: false,
        non_delivery_confirmed: true,
      })
    expect(host.starts).toHaveLength(0)
    expect(host.dispatched).toHaveLength(0)
    // A read is not fenced: it changes nothing.
    expect(await ok({ ...frame('list_projects'), stop_generation: 2 })).toMatchObject({ partial: false })
    expect(applied).toEqual([])
  })

  it("never fences a stop_chat: the owner's stop still reaches a running chat", async () => {
    idleChat('c1')
    host.busyChats.add('c1')
    generation = 3
    const stale = { ...frame('stop_chat', { chat: { machine_id: MACHINE, chat_id: 'c1' } }), stop_generation: 2 }
    expect(await ok(stale)).toMatchObject({ state: 'accepted', status: 'stopped' })
    expect(host.interrupts).toContain('c1')
    expect(applied).toEqual([])
  })

  it('waits for a stop already running before it adds work, and a stop_chat does not wait', async () => {
    idleChat('c1')
    generation = 2
    await ok(frame('send_to_chat', { chat: { machine_id: MACHINE, chat_id: 'c1' }, message: 'Go' }))
    // The same generation: nothing is recorded, but the call went on the stop queue.
    expect(queued).toEqual([2])
    expect(applied).toEqual([])
    host.busyChats.add('c1')
    expect((await run(frame('stop_chat', { chat: { machine_id: MACHINE, chat_id: 'c1' } }))).ok).toBe(true)
    expect(queued).toEqual([2])
    // A read never goes near the stop queue.
    await ok(frame('list_projects'))
    expect(queued).toEqual([2])
  })

  it('fences a mutation when a newer stop completes while it waits on the stop queue', async () => {
    idleChat('c1')
    generation = 2
    // The relay's control frame for generation 3 is handled while this call waits.
    onStopQueue = async () => {
      generation = 3
    }
    for (const f of [
      frame('start_chat', { project: 'Raves site', message: 'Go' }),
      frame('send_to_chat', { chat: { machine_id: MACHINE, chat_id: 'c1' }, message: 'Go' }),
    ])
      expect(await bad(f)).toMatchObject({
        code: 'policy_denied',
        delivered: false,
        non_delivery_confirmed: true,
      })
    expect(host.starts).toHaveLength(0)
    expect(host.dispatched).toHaveLength(0)
  })

  it('applies a stop generation it has not seen before it starts new work, and on a stop too', async () => {
    idleChat('c1')
    const ahead = { ...frame('start_chat', { project: 'Raves site', message: 'Go' }), stop_generation: 4 }
    expect((await run(ahead)).ok).toBe(true)
    expect(applied).toEqual([4])
    const stop = { ...frame('stop_chat', { chat: { machine_id: MACHINE, chat_id: 'c1' } }), stop_generation: 6 }
    expect((await run(stop)).ok).toBe(true)
    expect(applied).toEqual([4, 6])
  })
})

describe('idempotency', () => {
  it('answers a repeated start_chat frame from the record and sends nothing twice', async () => {
    const f = frame('start_chat', { project: 'Raves site', message: 'Fix the header' })
    const first = await ok(f)
    const again = await ok(f)
    expect(again).toMatchObject({ call_id: first.call_id, replayed: true, message_id: first.message_id })
    expect(host.dispatched).toHaveLength(1)
    expect(getMessagesForConversation((first.chat as { chat_id: string }).chat_id)).toHaveLength(1)
  })

  it('answers a repeated send_to_chat frame after a restart of this desktop and sends nothing twice', async () => {
    idleChat('c1')
    const f = frame('send_to_chat', { chat: { machine_id: MACHINE, chat_id: 'c1' }, message: 'Next' })
    const first = await ok(f)
    expect(host.dispatched).toHaveLength(1)
    // A restarted desktop: new services over the same database, nothing in flight.
    build()
    const again = await ok(f)
    expect(again).toMatchObject({ call_id: first.call_id, replayed: true, message_id: first.message_id })
    expect(host.dispatched).toHaveLength(1)
    expect(getMessagesForConversation('c1')).toHaveLength(1)
  })

  it('refuses the same relay call id with another body', async () => {
    const f = frame('send_to_chat', { chat: { machine_id: MACHINE, chat_id: 'c1' }, message: 'Next' })
    idleChat('c1')
    await ok(f)
    expect(await bad({ ...f, arguments: { ...f.arguments, message: 'Other' } })).toMatchObject({
      code: 'idempotency_conflict',
      call_id: f.call_id,
    })
    expect(host.dispatched).toHaveLength(1)
  })
})

describe('the chat the relay starts', () => {
  it('is an ordinary chat in the sidebar, labelled with its bridge origin', async () => {
    const started = await ok(frame('start_chat', { project: 'Raves site', message: 'Fix the header' }))
    const chatId = (started.chat as { chat_id: string }).chat_id
    const rows = getManagedRootConversationsForProjects([ALLOWED]).get(ALLOWED) ?? []
    expect(rows.map((r) => r.id)).toContain(chatId)

    const markers = bridgeOriginMarkers()
    const [row] = withBridgeOrigins([{ id: chatId }], markers)
    expect(row.bridgeOrigin).toEqual({ stop: null })
    // What both phones decode and show on the row.
    expect(bridgeOriginLabel(parseBridgeOriginMarker(row.bridgeOrigin)!)).toBe('From the bridge')
    expect(getBridgeOrigin(chatId)?.source).toBe('relay')

    await ok(frame('stop_chat', { chat: started.chat }))
    expect(bridgeOriginLabel(parseBridgeOriginMarker(bridgeOriginMarkers().get(chatId))!)).toBe('Bridge stopped')
  })
})
