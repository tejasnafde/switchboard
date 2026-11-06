/**
 * The shared bridge contract: the flag is off by default, the seven tool
 * names, the default project policy, the mode cap that refuses instead of
 * promoting, the public view without the local root, the delivery state
 * moves, the error shape and the canonical input hash.
 */
import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import {
  BRIDGE_DEVICE_CAPABILITY,
  BRIDGE_ERROR_CODES,
  BRIDGE_TOOL_NAMES,
  DEFAULT_BRIDGE_ACTIONS,
  INSTINCT_BRIDGE_ENABLED,
  bridgeCallTransitionAllowed,
  bridgeError,
  bridgeInputHash,
  canonicalBridgeInput,
  defaultBridgeProjectPolicy,
  instinctBridgeEnabled,
  parseBridgeControl,
  publicProjectView,
  resolveBridgeMode,
  withBridgeOrigins,
} from '../../src/shared/bridge'
import { labsFlag } from '../../src/shared/labs'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const policy = defaultBridgeProjectPolicy({
  project_id: 'p1',
  label: 'Website',
  machine_id: 'mac-work',
  canonical_local_root: '/Users/me/site',
})

describe('instinct_bridge flag', () => {
  it('is off by default and on by the env var or the labs row', () => {
    expect(INSTINCT_BRIDGE_ENABLED).toBe(false)
    expect(instinctBridgeEnabled({}, () => null)).toBe(false)
    expect(instinctBridgeEnabled({ SB_INSTINCT_BRIDGE: '1' }, () => null)).toBe(true)
    expect(instinctBridgeEnabled({}, (k) => (k === 'labs.instinct_bridge' ? 'true' : null))).toBe(true)
    expect(labsFlag('instinct_bridge')).toMatchObject({
      envVar: 'SB_INSTINCT_BRIDGE',
      defaultOn: false,
    })
    // Advertised now that the relay can run the tools.
    expect(labsFlag('instinct_bridge')!.capability).toBe(BRIDGE_DEVICE_CAPABILITY)
  })
})

describe('contract', () => {
  it('exposes exactly the seven tools', () => {
    expect([...BRIDGE_TOOL_NAMES].sort()).toEqual([
      'list_projects',
      'list_recent_chats',
      'read_chat',
      'search_chats',
      'send_to_chat',
      'start_chat',
      'stop_chat',
    ])
  })

  it('defaults to auto capped at auto, edits and checks on, publication off', () => {
    expect(policy.default_mode).toBe('auto')
    expect(policy.maximum_mode).toBe('auto')
    expect(DEFAULT_BRIDGE_ACTIONS).toEqual({
      edit: true,
      checks: true,
      commit: false,
      push: false,
      pr: false,
      merge: false,
      deploy: false,
    })
    expect(policy.actions).not.toBe(DEFAULT_BRIDGE_ACTIONS)
  })

  it('leaves the local root out of the public view', () => {
    const view = publicProjectView(policy)
    expect(view).not.toHaveProperty('canonical_local_root')
    expect(JSON.stringify(view)).not.toContain('/Users/me/site')
    expect(view.project_id).toBe('p1')
  })
})

describe('resolveBridgeMode', () => {
  it('uses the default when none is asked and allows a mode at or below the cap', () => {
    expect(resolveBridgeMode(undefined, policy)).toEqual({ ok: true, mode: 'auto' })
    expect(resolveBridgeMode('plan', policy)).toEqual({ ok: true, mode: 'plan' })
    expect(resolveBridgeMode('auto', policy)).toEqual({ ok: true, mode: 'auto' })
  })

  it('refuses a wider or unknown mode instead of changing it', () => {
    expect(resolveBridgeMode('full-access', policy)).toEqual({ ok: false, code: 'mode_not_allowed' })
    expect(resolveBridgeMode('yolo', policy)).toEqual({ ok: false, code: 'mode_not_allowed' })
    expect(resolveBridgeMode('auto', { default_mode: 'plan', maximum_mode: 'sandbox' })).toEqual({
      ok: false,
      code: 'mode_not_allowed',
    })
  })
})

describe('call delivery states', () => {
  it('moves forward only, with delivery_unknown reconciled to a final state', () => {
    expect(bridgeCallTransitionAllowed('recorded', 'dispatching')).toBe(true)
    expect(bridgeCallTransitionAllowed('recorded', 'accepted')).toBe(false)
    expect(bridgeCallTransitionAllowed('delivery_unknown', 'accepted')).toBe(true)
    expect(bridgeCallTransitionAllowed('accepted', 'rejected')).toBe(false)
    expect(bridgeCallTransitionAllowed('rejected', 'dispatching')).toBe(false)
  })
})

describe('bridgeError', () => {
  it('carries the code, a retry advice and nullable call and target', () => {
    expect(BRIDGE_ERROR_CODES).toHaveLength(22)
    expect(bridgeError('killed', 'x').retry).toBe('ask_owner')
    expect(bridgeError('machine_offline', 'The work computer is asleep. Nothing started.')).toEqual({
      code: 'machine_offline',
      message: 'The work computer is asleep. Nothing started.',
      call_id: null,
      retry: 'ask_owner',
      target: null,
    })
    expect(bridgeError('delivery_unknown', 'Check the chat.', { call_id: 'bcall_1' }).retry).toBe('read_first')
  })
})

describe('canonical input hash', () => {
  it('ignores key order, undefined fields and the idempotency key, and changes with the body', () => {
    const a = bridgeInputHash('start_chat', { project: 'p', message: 'hi', idempotency_key: 'k1' }, sha256)
    const b = bridgeInputHash(
      'start_chat',
      { message: 'hi', project: 'p', mode: undefined, idempotency_key: 'k2' },
      sha256,
    )
    expect(a).toBe(b)
    expect(a).not.toBe(bridgeInputHash('start_chat', { project: 'p', message: 'bye' }, sha256))
    expect(a).not.toBe(bridgeInputHash('send_to_chat', { project: 'p', message: 'hi' }, sha256))
    expect(canonicalBridgeInput('stop_chat', { chat: { machine_id: 'm', chat_id: 'c' } })).toBe(
      '{"args":{"chat":{"chat_id":"c","machine_id":"m"}},"operation":"stop_chat"}',
    )
    expect(() => bridgeInputHash('stop_chat', {}, () => 'nope')).toThrow(/SHA-256/)
  })

  it('keeps an own __proto__ key in the canonical form', () => {
    const withProto = JSON.parse('{"chat":{"__proto__":{"x":1}}}') as Record<string, unknown>
    expect(canonicalBridgeInput('stop_chat', withProto)).not.toBe(canonicalBridgeInput('stop_chat', { chat: {} }))
  })
})

describe('stop controls', () => {
  it('reads a control only with a safe integer generation >= 0 and a boolean kill', () => {
    expect(parseBridgeControl({ stop_generation: 0, killed: false })).toEqual({ stop_generation: 0, killed: false })
    expect(parseBridgeControl({ stop_generation: 9, killed: true })).toEqual({ stop_generation: 9, killed: true })
    for (const bad of [
      { stop_generation: -1, killed: true },
      { stop_generation: 1.5, killed: true },
      { stop_generation: '2', killed: true },
      { stop_generation: Number.MAX_SAFE_INTEGER + 1, killed: true },
      { stop_generation: 2, killed: 1 },
      { stop_generation: 2 },
      {},
    ])
      expect(parseBridgeControl(bad)).toBeNull()
  })

  it('marks only the chat rows that have a bridge origin', () => {
    const rows = [{ id: 'a' }, { id: 'b' }]
    expect(withBridgeOrigins(rows, new Map())).toBe(rows)
    expect(withBridgeOrigins(rows, new Map([['b', { stop: 'pending' as const }]]))).toEqual([
      { id: 'a' },
      { id: 'b', bridgeOrigin: { stop: 'pending' } },
    ])
  })
})
