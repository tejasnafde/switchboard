/**
 * The Expo app shows a chat's real mode and sends a mode only when the user
 * picked one on the phone, so a turn from the phone never drops a chat that
 * the desktop set to full access back to the store's "sandbox" default.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore, flushQueue, resetQueue, threadKey } from '../../apps/mobile/src/stores/chat'
import { buildTurn } from '../../apps/mobile/src/lib/turn-submit'
import { parseQueuedMessage } from '../../apps/mobile/src/lib/outbox-model'
import type { RuntimeEvent } from '../../src/shared/provider-events'

const CONN = 'conn-1'
const THREAD = 'thread-1'
const KEY = threadKey(CONN, THREAD)

const thread = () => useChatStore.getState().threads[KEY]!
const turn = () => buildTurn({ connectionId: CONN, threadId: THREAD, text: 'hi', runtimeMode: thread().pickedMode }).queued

function announce(runtimeMode: string): void {
  useChatStore.getState().ingest(CONN, {
    type: 'session.provider', threadId: THREAD, provider: 'claude', instanceId: 'work', instanceName: 'Work', runtimeMode,
  } as RuntimeEvent)
  flushQueue()
}

beforeEach(() => {
  resetQueue()
  useChatStore.setState({ threads: {}, activeKey: KEY })
})

describe('mobile runtime mode sync', () => {
  it('a full-access chat shows full access and a turn from the phone carries no mode', () => {
    useChatStore.getState().setRuntimeMode(KEY, 'full-access')
    expect(thread().runtimeMode).toBe('full-access')
    const queued = turn()
    expect(queued.runtimeMode).toBeUndefined()
    expect(queued.modePicked).toBeUndefined()
  })

  it('a pick not yet applied rides on one turn, and stops once it reached the backend', () => {
    useChatStore.getState().setRuntimeMode(KEY, 'full-access')
    useChatStore.getState().pickRuntimeMode(KEY, 'auto')
    // History read later must not hide the pick.
    useChatStore.getState().setRuntimeMode(KEY, 'full-access')
    expect(thread().runtimeMode).toBe('auto')
    expect(turn()).toMatchObject({ runtimeMode: 'auto', modePicked: true })
    // What ThreadScreen does once setRuntimeMode resolves, or a turn carried it.
    useChatStore.getState().settlePickedMode(KEY, 'auto')
    expect(thread().runtimeMode).toBe('auto')
    expect(turn().runtimeMode).toBeUndefined()
  })

  it('a mode changed on the desktop shows on the phone and wins over a pick not yet sent, profile too', () => {
    useChatStore.getState().pickRuntimeMode(KEY, 'plan')
    announce('full-access')
    expect(thread()).toMatchObject({ runtimeMode: 'full-access', pickedMode: undefined, instanceId: 'work', instanceName: 'Work' })
  })

  it('drops the default mode an older build stored on an untried message, and keeps a tried or picked one', () => {
    const base = { connectionId: CONN, threadId: THREAD, messageId: 'm1', text: 'hi', createdAt: 1 }
    expect(parseQueuedMessage({ ...base, runtimeMode: 'sandbox', attempts: 0 })?.runtimeMode).toBeUndefined()
    // Already tried: the mode is part of the backend's fingerprint for this origin.
    expect(parseQueuedMessage({ ...base, runtimeMode: 'sandbox', attempts: 1 })?.runtimeMode).toBe('sandbox')
    expect(parseQueuedMessage({ ...base, runtimeMode: 'sandbox', attempts: 0, deliveryState: 'ambiguous' })?.runtimeMode).toBe('sandbox')
    expect(parseQueuedMessage({ ...base, runtimeMode: 'sandbox', attempts: 0, providerText: 'hi' })?.runtimeMode).toBe('sandbox')
    const picked = buildTurn({ connectionId: CONN, threadId: THREAD, text: 'hi', runtimeMode: 'plan' }).queued
    expect(parseQueuedMessage(JSON.parse(JSON.stringify(picked)))).toEqual(picked)
  })
})
