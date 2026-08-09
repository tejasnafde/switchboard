/**
 * Teaching the desktop about sessions it did not start.
 *
 * The backend broadcasts every runtime event to every connected client, but the
 * desktop's session list only ever grew from a user action in that window. Its
 * reducers are `sessions.map(...)`, so an event for an unknown threadId matched
 * nothing and vanished. A chat started on the phone therefore sat in the
 * sidebar looking idle while it was actively streaming, and its sub-agent
 * messages - which exist only in the live stream, never in reloaded history -
 * were lost for good.
 *
 * The fix is to ask the backend what is running and merge the answer in. The
 * merge is the delicate half: it must not touch messages already collected, and
 * it must not resurrect a session the user closed in this window.
 */
import { describe, it, expect } from 'vitest'
import {
  mergeLiveSessions,
  toAgentStatus,
  type LiveSessionSummary,
} from '../../src/renderer/stores/liveSessionMerge'

interface Existing {
  id: string
  status: string
  messages: string[]
  title?: string
}

const live = (over: Partial<LiveSessionSummary> = {}): LiveSessionSummary => ({
  threadId: 't-phone',
  provider: 'claude',
  status: 'running',
  runtimeMode: 'sandbox',
  cwd: '/repo',
  createdAt: 1,
  ...over,
})

describe('toAgentStatus', () => {
  it('passes through the states both sides share', () => {
    expect(toAgentStatus('running')).toBe('running')
    expect(toAgentStatus('thinking')).toBe('thinking')
    expect(toAgentStatus('error')).toBe('error')
    expect(toAgentStatus('idle')).toBe('idle')
  })

  it('maps the two backend states the renderer has no name for', () => {
    // A blind cast left an adopted row in a state nothing matches - notably
    // `shouldEvictMessages`, which only releases a transcript when idle.
    expect(toAgentStatus('connecting')).toBe('running')
    expect(toAgentStatus('stopped')).toBe('exited')
  })

  it('falls back to idle for anything unrecognised', () => {
    expect(toAgentStatus('some-future-state')).toBe('idle')
  })
})

describe('mergeLiveSessions', () => {
  it('adds a session this window has never seen', () => {
    const result = mergeLiveSessions<Existing>({
      existing: [],
      live: [live()],
      create: (s) => ({ id: s.threadId, status: s.status, messages: [] }),
      applyStatus: (row, status) => ({ ...row, status }),
    })
    expect(result.map((r) => r.id)).toEqual(['t-phone'])
    expect(result[0].status).toBe('running')
  })

  it('updates the status of a session it already has', () => {
    const result = mergeLiveSessions<Existing>({
      existing: [{ id: 't-phone', status: 'idle', messages: ['a'] }],
      live: [live({ status: 'running' })],
      create: (s) => ({ id: s.threadId, status: s.status, messages: [] }),
      applyStatus: (row, status) => ({ ...row, status }),
    })
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('running')
  })

  it('never discards messages already collected for a known session', () => {
    // The desktop may have been streaming this chat for a while. Replacing the
    // row wholesale would wipe the transcript the user is reading.
    const result = mergeLiveSessions<Existing>({
      existing: [{ id: 't-phone', status: 'idle', messages: ['a', 'b'], title: 'mine' }],
      live: [live()],
      create: (s) => ({ id: s.threadId, status: s.status, messages: [] }),
      applyStatus: (row, status) => ({ ...row, status }),
    })
    expect(result[0].messages).toEqual(['a', 'b'])
    expect(result[0].title).toBe('mine')
  })

  it('leaves sessions the backend did not mention alone', () => {
    // A local chat that has simply not been started yet is still the user's
    // open tab. Absence from the live list is not a reason to close it.
    const result = mergeLiveSessions<Existing>({
      existing: [{ id: 't-local', status: 'idle', messages: [] }],
      live: [live()],
      create: (s) => ({ id: s.threadId, status: s.status, messages: [] }),
      applyStatus: (row, status) => ({ ...row, status }),
    })
    expect(result.map((r) => r.id).sort()).toEqual(['t-local', 't-phone'])
    expect(result.find((r) => r.id === 't-local')?.status).toBe('idle')
  })

  it('preserves the existing order and appends what is new', () => {
    // The sidebar reads this order. Reshuffling it on every reconnect would
    // move chats under the user's cursor.
    const result = mergeLiveSessions<Existing>({
      existing: [
        { id: 'a', status: 'idle', messages: [] },
        { id: 'b', status: 'idle', messages: [] },
      ],
      live: [live({ threadId: 'c' }), live({ threadId: 'b' })],
      create: (s) => ({ id: s.threadId, status: s.status, messages: [] }),
      applyStatus: (row, status) => ({ ...row, status }),
    })
    expect(result.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('is a no-op when nothing is running', () => {
    const existing = [{ id: 'a', status: 'idle', messages: [] }]
    expect(mergeLiveSessions<Existing>({
      existing,
      live: [],
      create: (s) => ({ id: s.threadId, status: s.status, messages: [] }),
      applyStatus: (row, status) => ({ ...row, status }),
    })).toEqual(existing)
  })

  it('does not duplicate a session the backend reports twice', () => {
    const result = mergeLiveSessions<Existing>({
      existing: [],
      live: [live(), live()],
      create: (s) => ({ id: s.threadId, status: s.status, messages: [] }),
      applyStatus: (row, status) => ({ ...row, status }),
    })
    expect(result).toHaveLength(1)
  })
})
