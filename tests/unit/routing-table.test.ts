/**
 * RoutingTable: resolves which machine a renderer call targets. A call is keyed
 * by its resource id (threadId / terminal id) and looked up in the bindings the
 * renderer registers at session/terminal creation; create-style calls that
 * carry an explicit machineId route there directly. Unbound / unknown -> local.
 */
import { describe, it, expect } from 'vitest'
import { RoutingTable, routingKey } from '../../src/preload/routing-table'

describe('routingKey', () => {
  it('uses a string first arg as the key (sendTurn(threadId, ...))', () => {
    expect(routingKey(['thr_1', 'hello'])).toBe('thr_1')
  })
  it('reads threadId off an options object (startSession(opts))', () => {
    expect(routingKey([{ threadId: 'thr_2', cwd: '/x' }])).toBe('thr_2')
  })
  it('reads id off a payload object (terminal write({id,data}))', () => {
    expect(routingKey([{ id: 'term_3', data: 'ls' }])).toBe('term_3')
  })
  it('returns null when there is no usable key', () => {
    expect(routingKey([])).toBeNull()
    expect(routingKey([42])).toBeNull()
    expect(routingKey([{ cwd: '/x' }])).toBeNull()
  })
})

describe('RoutingTable', () => {
  it('defaults to local when nothing is bound', () => {
    const t = new RoutingTable()
    expect(t.resolve('provider:send-turn', ['thr_1'])).toBe('local')
  })

  it('routes a bound resource to its machine', () => {
    const t = new RoutingTable()
    t.bind('thr_1', 'm1')
    expect(t.resolve('provider:send-turn', ['thr_1'])).toBe('m1')
    expect(t.resolve('provider:start-session', [{ threadId: 'thr_1' }])).toBe('m1')
  })

  it('routes create-style calls by an explicit machineId on the payload', () => {
    const t = new RoutingTable()
    expect(t.resolve('terminal:create', [{ cwd: '/x', machineId: 'm2' }])).toBe('m2')
  })

  it('binding to local clears any existing binding', () => {
    const t = new RoutingTable()
    t.bind('thr_1', 'm1')
    t.bind('thr_1', 'local')
    expect(t.resolve('x', ['thr_1'])).toBe('local')
  })

  it('unbind removes the binding', () => {
    const t = new RoutingTable()
    t.bind('term_3', 'm1')
    t.unbind('term_3')
    expect(t.resolve('terminal:kill', ['term_3'])).toBe('local')
  })

  it('forgetMachine drops every binding for a disconnected machine', () => {
    const t = new RoutingTable()
    t.bind('a', 'm1')
    t.bind('b', 'm1')
    t.bind('c', 'm2')
    t.forgetMachine('m1')
    expect(t.resolve('x', ['a'])).toBe('local')
    expect(t.resolve('x', ['b'])).toBe('local')
    expect(t.resolve('x', ['c'])).toBe('m2')
  })
})
