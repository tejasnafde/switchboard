/**
 * Two things live here:
 *
 * 1. Machine-tagged provider events - `shouldDeliverProviderEvent` /
 *    `onProviderEvent` drop cross-machine bleed when two machines emit the
 *    same threadId (e.g. a cloned repo yields identical Claude session
 *    UUIDs).
 * 2. Reconnect resync - `decideMachineTransition` / `initMachineReconnectResync`
 *    react to a remote machine's tunnel dropping and coming back with a
 *    fresh (session-less) server.
 *
 * `terminal-registry` is mocked so these tests don't need real xterm/DOM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useAgentStore } from '../../src/renderer/stores/agent-store'

vi.mock('../../src/renderer/services/terminal-registry', () => ({
  writeMachineNotice: vi.fn(),
}))

import { writeMachineNotice } from '../../src/renderer/services/terminal-registry'
import {
  shouldDeliverProviderEvent,
  onProviderEvent,
  decideMachineTransition,
  initMachineReconnectResync,
  __resetMachineReconnectResyncForTests,
} from '../../src/renderer/services/session-events'

describe('shouldDeliverProviderEvent', () => {
  it('passes through when the event carries no machineId (older adapters)', () => {
    expect(shouldDeliverProviderEvent({ machineId: 'm1' }, undefined)).toBe(true)
  })

  it('passes through when the session has no bound machineId', () => {
    expect(shouldDeliverProviderEvent({}, 'm1')).toBe(true)
    expect(shouldDeliverProviderEvent(undefined, 'm1')).toBe(true)
  })

  it('passes through when both agree', () => {
    expect(shouldDeliverProviderEvent({ machineId: 'm1' }, 'm1')).toBe(true)
  })

  it('drops when session and event machines disagree', () => {
    expect(shouldDeliverProviderEvent({ machineId: 'm1' }, 'm2')).toBe(false)
  })
})

describe('onProviderEvent', () => {
  beforeEach(() => {
    useAgentStore.setState({ sessions: [], activeSessionId: null })
  })

  function stubOnEvent() {
    let handler: ((event: unknown) => void) | undefined
    const onEvent = vi.fn((cb: (event: unknown) => void) => {
      handler = cb
      return () => {}
    })
    ;(globalThis as unknown as { window: unknown }).window = {
      api: { provider: { onEvent } },
    }
    return { emit: (event: unknown) => handler?.(event) }
  }

  it('delivers an event whose threadId has no matching session', () => {
    const { emit } = stubOnEvent()
    const received: unknown[] = []
    onProviderEvent((e) => received.push(e))
    emit({ type: 'status', threadId: 'unknown-thread', status: 'idle' })
    expect(received).toHaveLength(1)
  })

  it('drops an event whose machineId disagrees with the bound session', () => {
    useAgentStore.getState().addSession({ id: 't1', type: 'claude-code', status: 'idle', machineId: 'm1' })
    const { emit } = stubOnEvent()
    const received: unknown[] = []
    onProviderEvent((e) => received.push(e))
    emit({ type: 'status', threadId: 't1', status: 'running', machineId: 'm2' })
    expect(received).toHaveLength(0)
  })

  it('delivers an event whose machineId matches the bound session', () => {
    useAgentStore.getState().addSession({ id: 't1', type: 'claude-code', status: 'idle', machineId: 'm1' })
    const { emit } = stubOnEvent()
    const received: unknown[] = []
    onProviderEvent((e) => received.push(e))
    emit({ type: 'status', threadId: 't1', status: 'running', machineId: 'm1' })
    expect(received).toHaveLength(1)
  })
})

describe('decideMachineTransition', () => {
  it('leaving connected is "lost" (a drop into error or a manual disconnect into offline)', () => {
    expect(decideMachineTransition('connected', 'error', false)).toBe('lost')
    expect(decideMachineTransition('connected', 'offline', false)).toBe('lost')
  })

  it('a machine that never connected has nothing to lose', () => {
    expect(decideMachineTransition(undefined, 'error', false)).toBe(null)
    expect(decideMachineTransition('connecting', 'error', false)).toBe(null)
  })

  it('staying in error is not reported again', () => {
    expect(decideMachineTransition('error', 'error', true)).toBe(null)
  })

  it('coming back to connected after a loss is a reconnect (even through the connecting intermediate)', () => {
    expect(decideMachineTransition('connecting', 'connected', true)).toBe('reconnected')
    expect(decideMachineTransition('error', 'connected', true)).toBe('reconnected')
  })

  it('an initial connect (no prior loss) triggers no resync', () => {
    expect(decideMachineTransition('offline', 'connected', false)).toBe(null)
    expect(decideMachineTransition('connecting', 'connected', false)).toBe(null)
    expect(decideMachineTransition(undefined, 'connected', false)).toBe(null)
  })
})

describe('initMachineReconnectResync', () => {
  // reconnectResyncStarted is a module-level singleton by design (it must
  // survive across the app's lifetime); tests reset it explicitly so each
  // case gets its own subscription.
  beforeEach(() => {
    vi.clearAllMocks()
    __resetMachineReconnectResyncForTests()
    useAgentStore.setState({ sessions: [], activeSessionId: null })
  })

  function stubOnStatus() {
    let handler: ((machineId: string, status: string) => void) | undefined
    const onStatus = vi.fn((cb: (machineId: string, status: string) => void) => {
      handler = cb
      return () => {}
    })
    ;(globalThis as unknown as { window: unknown }).window = {
      api: { machines: { onStatus } },
    }
    return { emit: (machineId: string, status: string) => handler?.(machineId, status), onStatus }
  }

  it('resets in-flight sessions and notices panes the moment the tunnel drops', () => {
    useAgentStore.getState().addSession({ id: 't1', type: 'claude-code', status: 'running', machineId: 'm1' })
    useAgentStore.getState().addSession({ id: 't2', type: 'claude-code', status: 'thinking', machineId: 'm1' })
    const { emit } = stubOnStatus()
    initMachineReconnectResync()
    emit('m1', 'connected')
    emit('m1', 'error')

    expect(useAgentStore.getState().sessions.find((s) => s.id === 't1')?.status).toBe('idle')
    expect(useAgentStore.getState().sessions.find((s) => s.id === 't2')?.status).toBe('idle')
    expect(writeMachineNotice).toHaveBeenCalledWith('m1', expect.stringContaining('connection to m1 lost'))
  })

  it('resets in-flight sessions on a manual disconnect (connected -> offline) too', () => {
    useAgentStore.getState().addSession({ id: 't1', type: 'claude-code', status: 'running', machineId: 'm1' })
    const { emit } = stubOnStatus()
    initMachineReconnectResync()
    emit('m1', 'connected')
    emit('m1', 'offline')

    expect(useAgentStore.getState().sessions.find((s) => s.id === 't1')?.status).toBe('idle')
  })

  it('notices a reconnect after a loss, through the connecting intermediate', () => {
    const { emit } = stubOnStatus()
    initMachineReconnectResync()
    emit('m1', 'connected')
    emit('m1', 'error')
    emit('m1', 'connecting')
    emit('m1', 'connected')

    expect(writeMachineNotice).toHaveBeenCalledWith('m1', expect.stringContaining('machine reconnected'))
  })

  it('does not resync on an initial connect (no prior loss)', () => {
    useAgentStore.getState().addSession({ id: 't1', type: 'claude-code', status: 'running', machineId: 'm1' })
    const { emit } = stubOnStatus()
    initMachineReconnectResync()
    emit('m1', 'connecting')
    emit('m1', 'connected')

    expect(useAgentStore.getState().sessions.find((s) => s.id === 't1')?.status).toBe('running')
    expect(writeMachineNotice).not.toHaveBeenCalled()
  })

  it('is idempotent - a second call does not double-subscribe', () => {
    const { onStatus } = stubOnStatus()
    initMachineReconnectResync()
    initMachineReconnectResync()
    expect(onStatus).toHaveBeenCalledTimes(1)
  })
})
