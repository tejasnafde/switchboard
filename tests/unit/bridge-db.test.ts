/**
 * The bridge records on a real migrated database: the call ledger keyed by
 * operation and idempotency key, retirement to tombstones, recovery at start,
 * origins under the root chat id, the stop generation and policy revisions.
 */
import { createHash } from 'crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMigratedDb } from './helpers/test-db'
import {
  getBridgeCall,
  getBridgeOrigin,
  getBridgeProjectPolicy,
  listBridgeProjectPolicies,
  migrate,
  readBridgeStopGeneration,
  recordBridgeOrigin,
  recordThreadSession,
  recoverBridgeCalls,
  reserveBridgeCall,
  retireExpiredBridgeCalls,
  saveBridgeProjectPolicy,
  updateBridgeCallState,
  writeBridgeStopRecord,
} from '../../src/main/db/database'
import { BRIDGE_CALL_RETENTION_MS, bridgeInputHash, defaultBridgeProjectPolicy } from '../../src/shared/bridge'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/switchboard-vitest') } }))

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const hashOf = (args: Record<string, unknown>) => bridgeInputHash('start_chat', args, sha256)

function reserve(key: string, args: Record<string, unknown>, now?: number) {
  return reserveBridgeCall({
    operation: 'start_chat',
    idempotencyKey: key,
    inputHash: hashOf(args),
    machineId: 'mac-work',
    target: { project_id: 'p1' },
    policyRevision: 1,
    now,
  })
}

beforeEach(() => {
  createMigratedDb()
})

describe('reserveBridgeCall', () => {
  it('stores the call id the relay reserved and returns it on a replay', () => {
    const input = {
      callId: 'bcall_relay-1',
      operation: 'start_chat' as const,
      idempotencyKey: 'k1',
      inputHash: hashOf({ m: 1 }),
      machineId: 'mac-work',
      target: { project_id: 'p1' },
      policyRevision: 1,
    }
    expect(reserveBridgeCall(input)).toMatchObject({ kind: 'reserved', call: { callId: 'bcall_relay-1' } })
    expect(reserveBridgeCall(input)).toMatchObject({ kind: 'existing', call: { callId: 'bcall_relay-1' } })
  })

  it('returns the first record for the same key and body, with its first target', () => {
    const first = reserve('k1', { project: 'site', message: 'hi' })
    expect(first.kind).toBe('reserved')
    if (first.kind !== 'reserved') return
    expect(first.call.state).toBe('recorded')
    expect(first.call.callId).toMatch(/^bcall_/)

    const again = reserveBridgeCall({
      operation: 'start_chat',
      idempotencyKey: 'k1',
      inputHash: hashOf({ message: 'hi', project: 'site', idempotency_key: 'k1' }),
      machineId: 'mac-home',
      target: { project_id: 'p2' },
      policyRevision: 9,
    })
    expect(again).toEqual({ kind: 'existing', call: first.call })
  })

  it('refuses a changed body under the same key', () => {
    const first = reserve('k1', { project: 'site', message: 'hi' })
    const changed = reserve('k1', { project: 'site', message: 'bye' })
    expect(changed).toEqual({
      kind: 'conflict',
      code: 'idempotency_conflict',
      callId: first.kind === 'reserved' ? first.call.callId : '',
    })
  })

  it('keeps keys of different operations apart', () => {
    reserve('k1', { message: 'hi' })
    const stop = reserveBridgeCall({
      operation: 'stop_chat',
      idempotencyKey: 'k1',
      inputHash: bridgeInputHash('stop_chat', { chat: 'c' }, sha256),
      machineId: 'mac-work',
      target: null,
      policyRevision: null,
    })
    expect(stop.kind).toBe('reserved')
  })

  it('gives one call for the same key reserved twice in a row, nested in an outer transaction too', () => {
    const db = createMigratedDb()
    const both = db.transaction(() => [reserve('k1', { m: 1 }), reserve('k1', { m: 1 })])()
    expect(both[0]!.kind).toBe('reserved')
    expect(both[1]!.kind).toBe('existing')
    const ids = both.map((r) => (r.kind === 'reserved' || r.kind === 'existing' ? r.call.callId : null))
    expect(ids[0]).toBe(ids[1])
    expect((db.prepare('SELECT count(*) AS n FROM bridge_calls').get() as { n: number }).n).toBe(1)
  })

  it('answers request_retired for a key past retention, before and after the tombstone is written', () => {
    const t0 = 1_000_000
    const first = reserve('k1', { m: 1 }, t0)
    if (first.kind !== 'reserved') throw new Error('not reserved')
    const later = t0 + BRIDGE_CALL_RETENTION_MS
    expect(reserve('k1', { m: 1 }, later)).toEqual({
      kind: 'retired',
      code: 'request_retired',
      callId: first.call.callId,
    })

    expect(retireExpiredBridgeCalls(later)).toBe(1)
    const tomb = getBridgeCall(first.call.callId)!
    expect(tomb.retiredAt).toBe(later)
    expect(tomb.inputHash).toBe(first.call.inputHash)
    expect(tomb.target).toBeNull()
    expect(tomb.machineId).toBeNull()
    expect(reserve('k1', { m: 2 }, later + 1).kind).toBe('retired')
    expect(updateBridgeCallState(first.call.callId, 'dispatching')).toBe(false)
  })

  it('does not retire a call inside retention', () => {
    const t0 = 1_000_000
    reserve('k1', { m: 1 }, t0)
    expect(retireExpiredBridgeCalls(t0 + BRIDGE_CALL_RETENTION_MS - 1)).toBe(0)
  })
})

describe('updateBridgeCallState', () => {
  it('follows the delivery states and keeps accepted and rejected final', () => {
    const r = reserve('k1', { m: 1 })
    if (r.kind !== 'reserved') throw new Error('not reserved')
    const id = r.call.callId
    expect(updateBridgeCallState(id, 'accepted')).toBe(false)
    expect(updateBridgeCallState(id, 'dispatching')).toBe(true)
    expect(updateBridgeCallState(id, 'delivery_unknown', { errorCode: 'delivery_unknown' })).toBe(true)
    expect(updateBridgeCallState(id, 'accepted')).toBe(true)
    expect(updateBridgeCallState(id, 'rejected')).toBe(false)
    expect(getBridgeCall(id)!.state).toBe('accepted')
    expect(updateBridgeCallState('bcall_missing', 'dispatching')).toBe(false)
  })

  it('records whether a rejection never reached the machine', () => {
    const r = reserve('k1', { m: 1 })
    if (r.kind !== 'reserved') throw new Error('not reserved')
    updateBridgeCallState(r.call.callId, 'rejected', { errorCode: 'machine_offline', nonDeliveryConfirmed: true })
    expect(getBridgeCall(r.call.callId)).toMatchObject({
      state: 'rejected',
      errorCode: 'machine_offline',
      nonDeliveryConfirmed: true,
    })
  })

  it('keeps the stored detail when a later move omits it', () => {
    const recorded = reserve('k1', { m: 1 })
    const dispatching = reserve('k2', { m: 2 })
    if (recorded.kind !== 'reserved' || dispatching.kind !== 'reserved') throw new Error('not reserved')
    updateBridgeCallState(dispatching.call.callId, 'dispatching')
    recoverBridgeCalls()
    expect(updateBridgeCallState(dispatching.call.callId, 'rejected')).toBe(true)
    expect(getBridgeCall(recorded.call.callId)).toMatchObject({ state: 'rejected', nonDeliveryConfirmed: true })
    expect(getBridgeCall(dispatching.call.callId)).toMatchObject({
      state: 'rejected',
      errorCode: 'delivery_unknown',
      nonDeliveryConfirmed: null,
    })
  })
})

describe('recovery after a restart', () => {
  it('keeps the records through a second migrate and settles calls caught mid-flight', () => {
    const db = createMigratedDb()
    const recorded = reserve('k1', { m: 1 })
    const dispatching = reserve('k2', { m: 2 })
    const accepted = reserve('k3', { m: 3 })
    if (recorded.kind !== 'reserved' || dispatching.kind !== 'reserved' || accepted.kind !== 'reserved') {
      throw new Error('not reserved')
    }
    updateBridgeCallState(dispatching.call.callId, 'dispatching')
    updateBridgeCallState(accepted.call.callId, 'dispatching')
    updateBridgeCallState(accepted.call.callId, 'accepted')
    writeBridgeStopRecord({ generation: 1, killed: false, killPending: false })

    migrate(db)
    expect(recoverBridgeCalls()).toEqual({ rejected: 1, unknown: 1 })
    expect(getBridgeCall(recorded.call.callId)).toMatchObject({ state: 'rejected', nonDeliveryConfirmed: true })
    expect(getBridgeCall(dispatching.call.callId)).toMatchObject({
      state: 'delivery_unknown',
      errorCode: 'delivery_unknown',
    })
    expect(getBridgeCall(accepted.call.callId)!.state).toBe('accepted')
    expect(readBridgeStopGeneration()).toBe(1)
    expect(reserve('k1', { m: 1 }).kind).toBe('existing')
  })
})

describe('bridge origins', () => {
  it('stores the origin under the root id and reads it from a rotated id', () => {
    recordThreadSession('claude-uuid-1', 'agent_1')
    const origin = recordBridgeOrigin({
      conversationId: 'claude-uuid-1',
      callId: 'bcall_a',
      projectId: 'p1',
      machineId: 'mac-work',
      policyRevision: 2,
      source: 'local',
    })
    expect(origin.conversationId).toBe('agent_1')
    recordThreadSession('claude-uuid-2', 'claude-uuid-1')
    expect(getBridgeOrigin('claude-uuid-2')).toEqual(origin)
    expect(getBridgeOrigin('agent_1')).toEqual(origin)
    expect(getBridgeOrigin('agent_other')).toBeNull()
  })

  it('keeps the first origin when a later call reaches the same chat', () => {
    const first = recordBridgeOrigin({
      conversationId: 'agent_1',
      callId: 'bcall_a',
      projectId: 'p1',
      machineId: 'mac-work',
      policyRevision: 1,
      source: 'local',
    })
    const second = recordBridgeOrigin({
      conversationId: 'agent_1',
      callId: 'bcall_b',
      projectId: 'p1',
      machineId: 'mac-work',
      policyRevision: 3,
      source: 'local',
    })
    expect(second).toEqual(first)
  })

  it('stamps the stop generation current at the start', () => {
    writeBridgeStopRecord({ generation: 2, killed: false, killPending: false })
    const origin = recordBridgeOrigin({
      conversationId: 'agent_1',
      callId: 'bcall_a',
      projectId: 'p1',
      machineId: 'mac-work',
      policyRevision: 1,
      source: 'local',
    })
    expect(origin.stopGeneration).toBe(2)
  })
})

describe('stop generation', () => {
  it('starts at 0 and never goes down', () => {
    expect(readBridgeStopGeneration()).toBe(0)
    expect(writeBridgeStopRecord({ generation: 5, killed: false, killPending: false }).generation).toBe(5)
    expect(writeBridgeStopRecord({ generation: 3, killed: false, killPending: false }).generation).toBe(5)
    expect(readBridgeStopGeneration()).toBe(5)
  })
})

describe('project policies', () => {
  const base = defaultBridgeProjectPolicy({
    project_id: 'p1',
    label: 'Website',
    machine_id: 'mac-work',
    canonical_local_root: '/Users/me/site',
  })

  it('stores the defaults and raises the revision on each save', () => {
    const saved = saveBridgeProjectPolicy(base)
    expect(saved).toMatchObject({ ...base, revision: 1 })
    const changed = saveBridgeProjectPolicy({ ...base, actions: { ...base.actions, commit: true } })
    expect(changed.revision).toBe(2)
    expect(changed.actions.commit).toBe(true)
    expect(getBridgeProjectPolicy('p1')!.revision).toBe(2)
    expect(listBridgeProjectPolicies().map((p) => p.project_id)).toEqual(['p1'])
  })

  it('refuses a default mode above the cap', () => {
    expect(() => saveBridgeProjectPolicy({ ...base, default_mode: 'full-access' })).toThrow(/maximum mode/)
    expect(getBridgeProjectPolicy('p1')).toBeNull()
  })
})
