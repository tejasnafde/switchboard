/** `ChatSnoozer`: timers on a fake clock against the real snooze columns. */
import { createMigratedDb } from './helpers/test-db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppChannels } from '../../src/shared/ipc-channels'
import {
  archiveConversation,
  clearConversationInboxForTurn,
  getConversationSettled,
  getConversationSnooze,
  getDb,
  setConversationSnooze,
} from '../../src/main/db/database'
import {
  ChatSnoozer,
  SNOOZE_RESYNC_MS,
  startChatSnoozer,
  type ChatSnoozeHost,
} from '../../src/main/conversations/chat-snooze'
import { storeConversationSettled } from '../../src/main/conversations/chat-settle'

const T0 = new Date(2026, 10, 2, 9, 0).getTime()
const HOUR = 3600_000

let host: ChatSnoozeHost & { emit: ReturnType<typeof vi.fn>; pushWoke: ReturnType<typeof vi.fn> }
let cards: Set<string>
let snoozer: ChatSnoozer | null = null

function make(): ChatSnoozer {
  snoozer?.dispose()
  snoozer = new ChatSnoozer(host, () => Date.now())
  snoozer.start()
  return snoozer
}

const emitted = () =>
  host.emit.mock.calls
    .filter(([c]) => c === AppChannels.CONVERSATION_SNOOZED)
    .map(([, e]) => e as Record<string, unknown>)

beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
  const db = createMigratedDb()
  db.exec(
    "INSERT INTO projects (path, name) VALUES ('/r', 'r'); INSERT INTO conversations (id, project_path, title) VALUES ('c', '/r', 'Chat'), ('d', '/r', 'Other')",
  )
  db.exec("INSERT INTO thread_sessions (claude_session_id, thread_id) VALUES ('uuid-c', 'c')")
  cards = new Set()
  host = { emit: vi.fn(), needsYou: (id) => cards.has(id), pushWoke: vi.fn() }
})

afterEach(() => {
  snoozer?.dispose()
  snoozer = null
  vi.useRealTimers()
})

describe('ChatSnoozer', () => {
  it('snoozes, broadcasts, and wakes at the time with one push', () => {
    const s = make()
    expect(s.snooze('uuid-c', { until: T0 + HOUR })).toEqual({ ok: true, until: T0 + HOUR, pr: null, rev: 1 })
    expect(emitted()[0]).toMatchObject({ conversationId: 'c', snoozedUntil: T0 + HOUR, title: 'Chat' })
    vi.advanceTimersByTime(HOUR - 1)
    expect(getConversationSnooze('c')?.snoozedAt).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(getConversationSnooze('c')).toMatchObject({ snoozedAt: null, wokeReason: 'time' })
    expect(emitted().at(-1)).toMatchObject({ snoozedAt: null, wokeReason: 'time' })
    expect(host.pushWoke).toHaveBeenCalledTimes(1)
    expect(host.pushWoke).toHaveBeenCalledWith('c', 'Chat', 'Snooze ended')
  })

  it('refuses a chat that needs the user, a time in the past or too far, and an empty request', () => {
    const s = make()
    cards.add('c')
    expect(s.snooze('c', { until: T0 + HOUR })).toEqual({ ok: false, reason: 'needs_you' })
    cards.clear()
    expect(s.snooze('c', { until: T0 - 2 * 60_000 })).toEqual({ ok: false, reason: 'past' })
    expect(s.snooze('c', { until: T0 + 400 * 24 * HOUR })).toEqual({ ok: false, reason: 'too_far' })
    expect(s.snooze('c', { until: null })).toEqual({ ok: false, reason: 'empty' })
    expect(s.snooze('nope', { until: T0 + HOUR })).toEqual({ ok: false, reason: 'no_row' })
  })

  it('a stale timer does nothing after a re-snooze to a later time', () => {
    const s = make()
    s.snooze('c', { until: T0 + HOUR })
    s.snooze('c', { until: T0 + 3 * HOUR })
    vi.advanceTimersByTime(2 * HOUR)
    expect(getConversationSnooze('c')?.snoozedAt).not.toBeNull()
    vi.advanceTimersByTime(HOUR)
    expect(getConversationSnooze('c')?.wokeReason).toBe('time')
    expect(host.pushWoke).toHaveBeenCalledTimes(1)
  })

  it('rebuilds timers on a restart, and wakes at once a snooze that ended while closed', () => {
    setConversationSnooze('c', { until: T0 - 10 * 60_000, pr: null, prMark: null, at: T0 - HOUR })
    setConversationSnooze('d', { until: T0 + HOUR, pr: null, prMark: null, at: T0 - HOUR })
    make()
    vi.advanceTimersByTime(0)
    expect(getConversationSnooze('c')?.wokeReason).toBe('time')
    expect(getConversationSnooze('d')?.snoozedAt).not.toBeNull()
    vi.advanceTimersByTime(HOUR)
    expect(getConversationSnooze('d')?.wokeReason).toBe('time')
  })

  it('caps a far timer at 2^31-1 ms and fires again until the time comes', () => {
    const s = make()
    const far = T0 + 30 * 24 * HOUR
    s.snooze('c', { until: far })
    vi.advanceTimersByTime(2 ** 31 - 1)
    expect(getConversationSnooze('c')?.snoozedAt).not.toBeNull()
    vi.advanceTimersByTime(far - T0 - (2 ** 31 - 1))
    expect(getConversationSnooze('c')?.wokeReason).toBe('time')
  })

  it('resync picks up a snooze another process wrote', () => {
    make()
    setConversationSnooze('c', { until: T0 + 60_000, pr: null, prMark: null, at: T0 })
    vi.advanceTimersByTime(SNOOZE_RESYNC_MS + 1)
    expect(getConversationSnooze('c')?.wokeReason).toBe('time')
  })

  it('wakes early on a card and a failure, not on an agent message or a normal end', () => {
    const s = make()
    s.snooze('c', { until: T0 + HOUR })
    s.onEvent('uuid-c', { kind: 'message', from: 'agent', at: Date.now() + 1 })
    s.onEvent('c', { kind: 'turn_completed' })
    expect(getConversationSnooze('c')?.snoozedAt).not.toBeNull()
    s.onEvent('uuid-c', { kind: 'needs_you' })
    expect(getConversationSnooze('c')?.wokeReason).toBe('needs_you')
    expect(host.pushWoke).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    s.snooze('c', { until: T0 + HOUR })
    s.onEvent('c', { kind: 'error', at: T0 })
    expect(getConversationSnooze('c')?.snoozedAt).not.toBeNull()
    s.onEvent('c', { kind: 'error', at: Date.now() + 1 })
    expect(getConversationSnooze('c')?.wokeReason).toBe('error')
    // The old timer is gone with the snooze.
    vi.advanceTimersByTime(HOUR)
    expect(host.pushWoke).not.toHaveBeenCalled()
  })

  it('a person message sent before the snooze, delivered after the write, does not wake it', () => {
    const s = make()
    const sentAt = Date.now()
    vi.advanceTimersByTime(10)
    s.snooze('c', { until: T0 + HOUR })
    s.onEvent('c', { kind: 'message', from: 'person', at: sentAt })
    expect(getConversationSnooze('c')?.snoozedAt).not.toBeNull()
    s.onEvent('c', { kind: 'message', from: 'person', at: Date.now() + 1 })
    expect(getConversationSnooze('c')?.wokeReason).toBe('message')
  })

  it('a settle stays stored and reported when the snooze cleanup throws', () => {
    const active = startChatSnoozer(host)
    vi.spyOn(active, 'onCleared').mockImplementation(() => {
      throw new Error('snooze broadcast failed')
    })
    try {
      expect(storeConversationSettled(host, 'uuid-c', 700)).toBe(true)
      expect(getConversationSettled('c')).toBe(700)
    } finally {
      active.dispose()
    }
  })

  it('snoozing a settled chat unsettles it for every client', () => {
    const s = make()
    getDb().prepare("UPDATE conversations SET settled_at = 1 WHERE id = 'c'").run()
    expect(s.snooze('uuid-c', { until: T0 + HOUR })).toMatchObject({ ok: true })
    expect(getConversationSettled('c')).toBeNull()
    const settled = host.emit.mock.calls.filter(([c]) => c === AppChannels.CONVERSATION_SETTLED)
    expect(settled).toEqual([
      [AppChannels.CONVERSATION_SETTLED, { conversationId: 'c', settledAt: null, title: 'Chat' }],
    ])
    // A chat that was not settled sends no settle event.
    s.snooze('d', { until: T0 + HOUR })
    expect(host.emit.mock.calls.filter(([c]) => c === AppChannels.CONVERSATION_SETTLED)).toHaveLength(1)
  })

  it('Wake and Undo: no marker; Undo of a wake is refused once the chat moved on', () => {
    const s = make()
    const first = s.snooze('c', { until: T0 + HOUR })
    expect(first.ok && s.wake('c', 'wake_now')).toBe(true)
    expect(getConversationSnooze('c')).toMatchObject({ snoozedAt: null, wokeAt: null })
    const rev = getConversationSnooze('c')!.snoozeRev
    // Another device snoozed it meanwhile: the Undo's revision is stale.
    s.snooze('c', { until: T0 + 2 * HOUR })
    expect(s.snooze('c', { until: T0 + HOUR, expectRev: rev })).toEqual({ ok: false, reason: 'stale' })
  })

  it('Undo of a wake whose time has passed meanwhile is refused', () => {
    const s = make()
    s.snooze('c', { until: T0 + 60_000 })
    s.wake('c', 'wake_now')
    const rev = getConversationSnooze('c')!.snoozeRev
    vi.advanceTimersByTime(5 * 60_000)
    expect(s.snooze('c', { until: T0 + 60_000, expectRev: rev })).toEqual({ ok: false, reason: 'past' })
  })

  it('seen drops the marker; a user turn, a settle or an archive end the snooze for every client', () => {
    const s = make()
    s.snooze('c', { until: T0 + HOUR })
    s.onEvent('c', { kind: 'needs_you' })
    expect(s.seen('uuid-c')).toBe(true)
    expect(emitted().at(-1)).toMatchObject({ wokeAt: null, snoozedAt: null })

    s.snooze('c', { until: T0 + HOUR })
    archiveConversation('c')
    expect(getConversationSnooze('c')?.snoozedAt).toBeNull()
    vi.advanceTimersByTime(HOUR)
    expect(host.pushWoke).not.toHaveBeenCalled()
  })

  it('Undo never restores a time that has passed, even inside the grace minute', () => {
    const s = make()
    s.snooze('c', { until: T0 + 60_000 })
    vi.advanceTimersByTime(60_000)
    expect(host.pushWoke).toHaveBeenCalledTimes(1)
    s.wake('c', 'wake_now')
    const rev = getConversationSnooze('c')!.snoozeRev
    vi.advanceTimersByTime(10_000)
    expect(s.snooze('c', { until: T0 + 60_000, expectRev: rev })).toEqual({ ok: false, reason: 'past' })
    expect(host.pushWoke).toHaveBeenCalledTimes(1)
  })

  it('refuses an archived chat, and an archive or a turn clears the Woke marker for every client', () => {
    const s = make()
    s.snooze('c', { until: T0 + HOUR })
    s.onEvent('c', { kind: 'needs_you' })
    archiveConversation('c')
    expect(getConversationSnooze('c')?.wokeAt).toBeNull()
    expect(emitted().at(-1)).toMatchObject({ wokeAt: null })
    expect(s.snooze('c', { until: T0 + HOUR })).toEqual({ ok: false, reason: 'no_row' })

    s.snooze('d', { until: T0 + HOUR })
    s.onEvent('d', { kind: 'needs_you' })
    const before = emitted().length
    clearConversationInboxForTurn(getDb(), 'd')
    s.onCleared('d')
    expect(emitted().length).toBe(before + 1)
    expect(emitted().at(-1)).toMatchObject({ conversationId: 'd', wokeAt: null })
  })
})
