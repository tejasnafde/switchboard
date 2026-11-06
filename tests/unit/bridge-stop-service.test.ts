/**
 * The bridge stop controls on a real migrated database with a fake host:
 * a control is recorded before any chat stops, the generation never goes
 * down, a stale control and a relay that ordered no stop run none, a failed
 * stop rejects to its caller, the ack is confirmed only when every
 * chat stopped, a local kill is kept and sent again until the relay has it,
 * a kill is never cleared on its own, the lease and a revoked device stop
 * only relay-started work, and a restart or wake enforces the saved state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMigratedDb } from './helpers/test-db'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/switchboard-vitest') } }))

import {
  bridgeAutoResumeBlocked,
  getBridgeCall,
  getBridgeOrigin,
  readBridgeStopRecord,
  recordBridgeOrigin,
  reserveBridgeCall,
  setBridgeOriginStopState,
  writeBridgeStopRecord,
  type BridgeOriginSource,
} from '../../src/main/db/database'
import { BRIDGE_CLEAR_KILL_COMMAND, BridgeStopService, type BridgeStopHost } from '../../src/main/bridge/stop-service'
import { BRIDGE_CALL_RETENTION_MS, BRIDGE_CONTROL_LEASE_MS } from '../../src/shared/bridge'

const NOW = 1_800_000_000_000

class FakeStopHost implements BridgeStopHost {
  /** Root id to its origin source, for chats with bridge work running. */
  active = new Map<string, BridgeOriginSource>()
  /** Chats whose stop cannot be confirmed. */
  stuck = new Set<string>()
  stops: Array<{
    sources: readonly BridgeOriginSource[] | undefined
    record: ReturnType<typeof readBridgeStopRecord>
  }> = []
  frames: unknown[] = []
  connected = true
  enrolledHere = true
  contact: number | null = NOW
  now = () => NOW

  activeGroups = (sources?: readonly BridgeOriginSource[]) =>
    [...this.active].filter(([, s]) => !sources || sources.includes(s)).map(([id]) => id)
  stopGroups = async (sources?: readonly BridgeOriginSource[]) => {
    // What a stop sees on disk when it starts: the control must already be there.
    this.stops.push({ sources, record: readBridgeStopRecord() })
    const chats = this.activeGroups(sources)
    const unconfirmed = chats.filter((id) => this.stuck.has(id))
    const stopped = chats.filter((id) => !this.stuck.has(id))
    for (const id of stopped) this.active.delete(id)
    return { stopped, unconfirmed }
  }
  relay = {
    enrolled: () => this.enrolledHere,
    lastContactAt: () => this.contact,
    sendStopAck: (generation: number, state: 'confirmed' | 'unconfirmed') => {
      if (this.connected) this.frames.push({ type: 'stop_ack', stop_generation: generation, state })
      return this.connected
    },
    sendKill: (generation: number) => {
      if (this.connected) this.frames.push({ type: 'kill', stop_generation: generation })
      return this.connected
    },
  }
  chatTitle = (id: string) => (id === 'b1' ? 'Fix the header' : null)
}

let host: FakeStopHost
let service: BridgeStopService

function origin(id: string, source: BridgeOriginSource = 'local') {
  return recordBridgeOrigin({
    conversationId: id,
    callId: `bcall_${id}`,
    projectId: 'p',
    machineId: 'm',
    policyRevision: 1,
    source,
  })
}

beforeEach(() => {
  createMigratedDb()
  host = new FakeStopHost()
  service = new BridgeStopService(host)
})

describe('relay control', () => {
  it('records the generation and the kill before it stops anything, then acks confirmed', async () => {
    host.active.set('b1', 'local')
    host.active.set('b2', 'relay')
    await service.applyControl({ stop_generation: 3, killed: true })
    expect(host.stops).toHaveLength(1)
    expect(host.stops[0].record).toMatchObject({ generation: 3, killed: true })
    expect(host.stops[0].sources).toBeUndefined()
    expect(host.frames).toEqual([{ type: 'stop_ack', stop_generation: 3, state: 'confirmed' }])
    expect(readBridgeStopRecord().lastResult).toMatchObject({ generation: 3, state: 'confirmed', stopped: 2 })
  })

  it('acks unconfirmed and names the chats when one cannot be stopped', async () => {
    host.active.set('b1', 'local')
    host.stuck.add('b1')
    await service.applyControl({ stop_generation: 1, killed: false })
    expect(host.frames).toEqual([{ type: 'stop_ack', stop_generation: 1, state: 'unconfirmed' }])
    const status = service.status()
    expect(status.last_result).toMatchObject({
      state: 'unconfirmed',
      unconfirmed: ['b1'],
      unconfirmed_titles: ['Fix the header'],
    })
    expect(status.active_chats).toBe(1)
  })

  it('never lowers the generation, and a stale control runs no stop but acks the last result', async () => {
    await service.applyControl({ stop_generation: 7, killed: false })
    host.stops = []
    host.frames = []
    host.active.set('b1', 'local')
    await service.applyControl({ stop_generation: 3, killed: false })
    expect(readBridgeStopRecord().generation).toBe(7)
    expect(host.stops).toEqual([])
    expect(host.active.has('b1')).toBe(true)
    expect(host.frames).toEqual([{ type: 'stop_ack', stop_generation: 3, state: 'confirmed' }])
  })

  it('a control at generation 0 with no kill changes nothing and sends no ack', async () => {
    await service.applyControl({ stop_generation: 0, killed: false })
    expect(host.frames).toEqual([])
    expect(readBridgeStopRecord()).toMatchObject({ generation: 0, killed: false })
  })

  it('a stop that throws rejects to its caller, and the next control still runs', async () => {
    host.active.set('b1', 'local')
    host.stopGroups = () => Promise.reject(new Error('the provider is gone'))
    await expect(service.applyControl({ stop_generation: 1, killed: true })).rejects.toThrow('the provider is gone')
    host.stopGroups = async () => ({ stopped: ['b1'], unconfirmed: [] })
    await service.applyControl({ stop_generation: 2, killed: true })
    expect(readBridgeStopRecord()).toMatchObject({ generation: 2, lastResult: { generation: 2, stopped: 1 } })
  })

  it('leaves running work alone when the relay never ordered a stop', async () => {
    // A fresh desktop: the first welcome says generation 0, and this Mac has no result of its own.
    host.active.set('b1', 'local')
    host.active.set('b2', 'relay')
    await service.applyControl({ stop_generation: 0, killed: false })
    expect(host.stops).toEqual([])
    expect([...host.active.keys()]).toEqual(['b1', 'b2'])
    expect(host.frames).toEqual([])
    expect(readBridgeStopRecord().lastResult).toBeNull()
  })
})

describe('Stop all on this desktop', () => {
  it('raises the generation, kills, stops local and relay work and sends kill to the relay', async () => {
    host.active.set('b1', 'local')
    host.active.set('b2', 'relay')
    const status = await service.stopAll()
    expect(status).toMatchObject({ killed: true, stop_generation: 1, kill_pending: true, active_chats: 0 })
    expect(host.stops[0].record).toMatchObject({ generation: 1, killed: true })
    expect(host.frames).toEqual([{ type: 'kill', stop_generation: 1 }])
  })

  it('keeps the kill while disconnected, sends it on the next welcome, and drops pending once the relay has it', async () => {
    host.connected = false
    await service.stopAll()
    host.connected = true
    // The relay never heard of it: its welcome says generation 0, not killed.
    await service.applyControl({ stop_generation: 0, killed: false })
    expect(readBridgeStopRecord()).toMatchObject({ generation: 1, killed: true, killPending: true })
    expect(host.frames).toEqual([{ type: 'kill', stop_generation: 1 }])
    // The relay took the kill and broadcast its new generation.
    host.frames = []
    await service.applyControl({ stop_generation: 2, killed: true })
    expect(readBridgeStopRecord()).toMatchObject({ generation: 2, killed: true, killPending: false })
    expect(host.frames).toEqual([{ type: 'stop_ack', stop_generation: 2, state: 'confirmed' }])
  })

  it('a pending kill survives a relay that moved on without it', async () => {
    host.connected = false
    await service.stopAll()
    host.connected = true
    await service.applyControl({ stop_generation: 5, killed: false })
    expect(readBridgeStopRecord()).toMatchObject({ generation: 5, killed: true, killPending: true })
    expect(host.frames[0]).toEqual({ type: 'kill', stop_generation: 5 })
  })
})

describe('clearing a kill', () => {
  it('is never automatic: a stale control, a wake or a restart keep it', async () => {
    await service.applyControl({ stop_generation: 4, killed: true })
    await service.applyControl({ stop_generation: 2, killed: false })
    await service.onWake()
    service.enforceAtStart()
    expect(service.killed()).toBe(true)
  })

  it('on an enrolled desktop follows the relay only, and the page names the operator command', async () => {
    await service.applyControl({ stop_generation: 4, killed: true })
    expect(service.status().clear_command).toBe(BRIDGE_CLEAR_KILL_COMMAND)
    expect(() => service.clearLocalKill()).toThrow(/follows the relay/)
    // The operator's clear-kill: same generation, not killed.
    await service.applyControl({ stop_generation: 4, killed: false })
    expect(readBridgeStopRecord()).toMatchObject({ generation: 4, killed: false })
    expect(service.status().clear_command).toBeNull()
  })

  it('on a desktop that is not enrolled clears locally and keeps the generation', async () => {
    host.enrolledHere = false
    await service.stopAll()
    expect(service.status().clear_command).toBeNull()
    expect(service.clearLocalKill()).toMatchObject({ killed: false, stop_generation: 1, kill_pending: false })
  })
})

describe('control lease', () => {
  it('stops relay-started work when the relay has been silent past the lease, and nothing else', async () => {
    host.active.set('local', 'local')
    host.active.set('relay', 'relay')
    host.contact = NOW - BRIDGE_CONTROL_LEASE_MS + 1_000
    await service.checkLease()
    expect(host.stops).toEqual([])
    host.contact = NOW - BRIDGE_CONTROL_LEASE_MS - 1
    await service.checkLease()
    expect(host.stops.map((s) => s.sources)).toEqual([['relay']])
    expect([...host.active.keys()]).toEqual(['local'])
    expect(service.status().lease_expires_at).toBe(host.contact + BRIDGE_CONTROL_LEASE_MS)
  })

  it('counts no contact in this run as an expired lease', async () => {
    host.active.set('relay', 'relay')
    host.contact = null
    await service.checkLease()
    expect(host.active.size).toBe(0)
  })

  it('a revoked device or a removed enrollment stops relay-started work at once', async () => {
    host.active.set('local', 'local')
    host.active.set('relay', 'relay')
    await service.authorityLost('revoked')
    expect([...host.active.keys()]).toEqual(['local'])
    host.active.set('relay2', 'relay')
    await service.authorityLost('unenrolled')
    expect([...host.active.keys()]).toEqual(['local'])
  })

  it('on wake enforces a saved kill first, then an expired lease', async () => {
    await service.applyControl({ stop_generation: 1, killed: true })
    host.stops = []
    host.active.set('relay', 'relay')
    host.contact = NOW - 10 * 60_000
    await service.onWake()
    expect(host.stops.map((s) => s.sources)).toEqual([undefined])
    expect(host.active.size).toBe(0)

    // Not killed: only the lease applies.
    writeBridgeStopRecord({ generation: 1, killed: false, killPending: false })
    host.stops = []
    host.active.set('local', 'local')
    host.active.set('relay', 'relay')
    await service.onWake()
    expect(host.stops.map((s) => s.sources)).toEqual([['relay']])
    expect([...host.active.keys()]).toEqual(['local'])
  })
})

describe('at app start', () => {
  it('recovers and retires call records, and turns a stop left pending into unconfirmed', () => {
    const recorded = reserveBridgeCall({
      operation: 'start_chat',
      idempotencyKey: 'k1',
      inputHash: 'a'.repeat(64),
      machineId: 'm',
      target: null,
      policyRevision: 1,
    })
    const old = reserveBridgeCall({
      operation: 'send_to_chat',
      idempotencyKey: 'k2',
      inputHash: 'b'.repeat(64),
      machineId: 'm',
      target: null,
      policyRevision: 1,
      now: NOW - BRIDGE_CALL_RETENTION_MS - 1,
    })
    origin('b1')
    writeBridgeStopRecord({ generation: 2, killed: true, killPending: false })
    setBridgeOriginStopState(['b1'], 'pending')

    service.enforceAtStart()

    if (recorded.kind !== 'reserved' || old.kind !== 'reserved') throw new Error('not reserved')
    expect(getBridgeCall(recorded.call.callId)).toMatchObject({ state: 'rejected', nonDeliveryConfirmed: true })
    expect(getBridgeCall(old.call.callId)?.retiredAt).not.toBeNull()
    expect(getBridgeOrigin('b1')?.stopState).toBe('unconfirmed')
    expect(readBridgeStopRecord()).toMatchObject({
      generation: 2,
      killed: true,
      lastResult: { generation: 2, state: 'unconfirmed', unconfirmed: ['b1'] },
    })
  })

  it('with a saved kill or a later stop, a bridge chat is not resumed automatically; other chats are', () => {
    origin('b1')
    expect(bridgeAutoResumeBlocked('b1')).toBe(false)
    writeBridgeStopRecord({ generation: 1, killed: false, killPending: false })
    expect(bridgeAutoResumeBlocked('b1')).toBe(true)
    // A bridge call after the stop is new work under the new generation.
    origin('b1')
    expect(bridgeAutoResumeBlocked('b1')).toBe(false)
    writeBridgeStopRecord({ generation: 1, killed: true, killPending: false })
    service.enforceAtStart()
    expect(bridgeAutoResumeBlocked('b1')).toBe(true)
    expect(bridgeAutoResumeBlocked('someone-elses-chat')).toBe(false)
  })
})
