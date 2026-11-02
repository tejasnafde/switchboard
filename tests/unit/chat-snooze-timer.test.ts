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
  setConversationSettled,
  setConversationSnooze,
} from '../../src/main/db/database'
import {
  ChatSnoozer,
  PR_WAKE_POLL_MS,
  SNOOZE_RESYNC_MS,
  startChatSnoozer,
  type ChatSnoozeHost,
} from '../../src/main/conversations/chat-snooze'
import type { PrReading } from '../../src/shared/chat-snooze'
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
  it('snoozes, broadcasts, and wakes at the time with one push', async () => {
    const s = make()
    expect(await s.snooze('uuid-c', { until: T0 + HOUR })).toEqual({ ok: true, until: T0 + HOUR, pr: null, rev: 1 })
    expect(emitted()[0]).toMatchObject({ conversationId: 'c', snoozedUntil: T0 + HOUR, title: 'Chat' })
    vi.advanceTimersByTime(HOUR - 1)
    expect(getConversationSnooze('c')?.snoozedAt).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(getConversationSnooze('c')).toMatchObject({ snoozedAt: null, wokeReason: 'time' })
    expect(emitted().at(-1)).toMatchObject({ snoozedAt: null, wokeReason: 'time' })
    expect(host.pushWoke).toHaveBeenCalledTimes(1)
    expect(host.pushWoke).toHaveBeenCalledWith('c', 'Chat', 'Snooze ended')
  })

  it('refuses a chat that needs the user, a time in the past or too far, and an empty request', async () => {
    const s = make()
    cards.add('c')
    expect(await s.snooze('c', { until: T0 + HOUR })).toEqual({ ok: false, reason: 'needs_you' })
    cards.clear()
    expect(await s.snooze('c', { until: T0 - 2 * 60_000 })).toEqual({ ok: false, reason: 'past' })
    expect(await s.snooze('c', { until: T0 + 400 * 24 * HOUR })).toEqual({ ok: false, reason: 'too_far' })
    expect(await s.snooze('c', { until: null })).toEqual({ ok: false, reason: 'empty' })
    expect(await s.snooze('nope', { until: T0 + HOUR })).toEqual({ ok: false, reason: 'no_row' })
  })

  it('a stale timer does nothing after a re-snooze to a later time', async () => {
    const s = make()
    await s.snooze('c', { until: T0 + HOUR })
    await s.snooze('c', { until: T0 + 3 * HOUR })
    vi.advanceTimersByTime(2 * HOUR)
    expect(getConversationSnooze('c')?.snoozedAt).not.toBeNull()
    vi.advanceTimersByTime(HOUR)
    expect(getConversationSnooze('c')?.wokeReason).toBe('time')
    expect(host.pushWoke).toHaveBeenCalledTimes(1)
  })

  it('rebuilds timers on a restart, and wakes at once a snooze that ended while closed', async () => {
    setConversationSnooze('c', { until: T0 - 10 * 60_000, pr: null, prMark: null, at: T0 - HOUR })
    setConversationSnooze('d', { until: T0 + HOUR, pr: null, prMark: null, at: T0 - HOUR })
    make()
    vi.advanceTimersByTime(0)
    expect(getConversationSnooze('c')?.wokeReason).toBe('time')
    expect(getConversationSnooze('d')?.snoozedAt).not.toBeNull()
    vi.advanceTimersByTime(HOUR)
    expect(getConversationSnooze('d')?.wokeReason).toBe('time')
  })

  it('caps a far timer at 2^31-1 ms and fires again until the time comes', async () => {
    const s = make()
    const far = T0 + 30 * 24 * HOUR
    await s.snooze('c', { until: far })
    vi.advanceTimersByTime(2 ** 31 - 1)
    expect(getConversationSnooze('c')?.snoozedAt).not.toBeNull()
    vi.advanceTimersByTime(far - T0 - (2 ** 31 - 1))
    expect(getConversationSnooze('c')?.wokeReason).toBe('time')
  })

  it('resync picks up a snooze another process wrote', async () => {
    make()
    setConversationSnooze('c', { until: T0 + 60_000, pr: null, prMark: null, at: T0 })
    vi.advanceTimersByTime(SNOOZE_RESYNC_MS + 1)
    expect(getConversationSnooze('c')?.wokeReason).toBe('time')
  })

  it('wakes early on a card and a failure, not on an agent message or a normal end', async () => {
    const s = make()
    await s.snooze('c', { until: T0 + HOUR })
    s.onEvent('uuid-c', { kind: 'message', from: 'agent', at: Date.now() + 1 })
    s.onEvent('c', { kind: 'turn_completed' })
    expect(getConversationSnooze('c')?.snoozedAt).not.toBeNull()
    s.onEvent('uuid-c', { kind: 'needs_you' })
    expect(getConversationSnooze('c')?.wokeReason).toBe('needs_you')
    expect(host.pushWoke).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    await s.snooze('c', { until: T0 + HOUR })
    s.onEvent('c', { kind: 'error', at: T0 })
    expect(getConversationSnooze('c')?.snoozedAt).not.toBeNull()
    s.onEvent('c', { kind: 'error', at: Date.now() + 1 })
    expect(getConversationSnooze('c')?.wokeReason).toBe('error')
    // The old timer is gone with the snooze.
    vi.advanceTimersByTime(HOUR)
    expect(host.pushWoke).not.toHaveBeenCalled()
  })

  it('a person message sent before the snooze, delivered after the write, does not wake it', async () => {
    const s = make()
    const sentAt = Date.now()
    vi.advanceTimersByTime(10)
    await s.snooze('c', { until: T0 + HOUR })
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

  it('snoozing a settled chat unsettles it for every client', async () => {
    const s = make()
    getDb().prepare("UPDATE conversations SET settled_at = 1 WHERE id = 'c'").run()
    expect(await s.snooze('uuid-c', { until: T0 + HOUR })).toMatchObject({ ok: true })
    expect(getConversationSettled('c')).toBeNull()
    const settled = host.emit.mock.calls.filter(([c]) => c === AppChannels.CONVERSATION_SETTLED)
    expect(settled).toEqual([
      [AppChannels.CONVERSATION_SETTLED, { conversationId: 'c', settledAt: null, title: 'Chat' }],
    ])
    // A chat that was not settled sends no settle event.
    await s.snooze('d', { until: T0 + HOUR })
    expect(host.emit.mock.calls.filter(([c]) => c === AppChannels.CONVERSATION_SETTLED)).toHaveLength(1)
  })

  it('Wake and Undo: no marker; Undo of a wake is refused once the chat moved on', async () => {
    const s = make()
    const first = await s.snooze('c', { until: T0 + HOUR })
    expect(first.ok && s.wake('c', 'wake_now')).toBe(true)
    expect(getConversationSnooze('c')).toMatchObject({ snoozedAt: null, wokeAt: null })
    const rev = getConversationSnooze('c')!.snoozeRev
    // Another device snoozed it meanwhile: the Undo's revision is stale.
    await s.snooze('c', { until: T0 + 2 * HOUR })
    expect(await s.snooze('c', { until: T0 + HOUR, expectRev: rev })).toEqual({ ok: false, reason: 'stale' })
  })

  it('Undo of a wake whose time has passed meanwhile is refused', async () => {
    const s = make()
    await s.snooze('c', { until: T0 + 60_000 })
    s.wake('c', 'wake_now')
    const rev = getConversationSnooze('c')!.snoozeRev
    vi.advanceTimersByTime(5 * 60_000)
    expect(await s.snooze('c', { until: T0 + 60_000, expectRev: rev })).toEqual({ ok: false, reason: 'past' })
  })

  it('seen drops the marker; a user turn, a settle or an archive end the snooze for every client', async () => {
    const s = make()
    await s.snooze('c', { until: T0 + HOUR })
    s.onEvent('c', { kind: 'needs_you' })
    expect(s.seen('uuid-c')).toBe(true)
    expect(emitted().at(-1)).toMatchObject({ wokeAt: null, snoozedAt: null })

    await s.snooze('c', { until: T0 + HOUR })
    archiveConversation('c')
    expect(getConversationSnooze('c')?.snoozedAt).toBeNull()
    vi.advanceTimersByTime(HOUR)
    expect(host.pushWoke).not.toHaveBeenCalled()
  })

  it('Undo never restores a time that has passed, even inside the grace minute', async () => {
    const s = make()
    await s.snooze('c', { until: T0 + 60_000 })
    vi.advanceTimersByTime(60_000)
    expect(host.pushWoke).toHaveBeenCalledTimes(1)
    s.wake('c', 'wake_now')
    const rev = getConversationSnooze('c')!.snoozeRev
    vi.advanceTimersByTime(10_000)
    expect(await s.snooze('c', { until: T0 + 60_000, expectRev: rev })).toEqual({ ok: false, reason: 'past' })
    expect(host.pushWoke).toHaveBeenCalledTimes(1)
  })

  it('refuses an archived chat, and an archive or a turn clears the Woke marker for every client', async () => {
    const s = make()
    await s.snooze('c', { until: T0 + HOUR })
    s.onEvent('c', { kind: 'needs_you' })
    archiveConversation('c')
    expect(getConversationSnooze('c')?.wokeAt).toBeNull()
    expect(emitted().at(-1)).toMatchObject({ wokeAt: null })
    expect(await s.snooze('c', { until: T0 + HOUR })).toEqual({ ok: false, reason: 'no_row' })

    await s.snooze('d', { until: T0 + HOUR })
    s.onEvent('d', { kind: 'needs_you' })
    const before = emitted().length
    clearConversationInboxForTurn(getDb(), 'd')
    s.onCleared('d')
    expect(emitted().length).toBe(before + 1)
    expect(emitted().at(-1)).toMatchObject({ conversationId: 'd', wokeAt: null })
  })

  describe('PR wakes', () => {
    const PR = 'github:acme/app#512'
    let reading: PrReading | null
    const reads: string[] = []
    const merged: string[] = []
    const withPr = () => {
      reads.length = 0
      merged.length = 0
      reading = { number: 512, state: 'open', headSha: 'a1', checksFailed: false, changesRequestedAt: null }
      host.readPr = async (pr) => {
        reads.push(pr)
        return reading && { ...reading }
      }
      host.settleMerged = (id) => void merged.push(id)
      return make()
    }

    it('stores the PR as it was, and refuses a closed or unreadable PR', async () => {
      const s = withPr()
      expect(await s.snooze('c', { until: null, pr: PR })).toMatchObject({ ok: true, pr: PR })
      expect(getConversationSnooze('c')?.snoozePrMark).toBe(
        JSON.stringify({ state: 'open', headSha: 'a1', checksFailed: false, changesRequestedAt: null }),
      )
      reading = { ...reading!, state: 'merged' }
      expect(await s.snooze('d', { until: null, pr: PR })).toEqual({ ok: false, reason: 'pr_closed' })
      reading = null
      expect(await s.snooze('d', { until: null, pr: PR })).toEqual({ ok: false, reason: 'pr_unreadable' })
    })

    it('reads every 5 minutes, wakes on a review that requests changes, pushes once and stops reading', async () => {
      const s = withPr()
      await s.snooze('c', { until: null, pr: PR })
      reads.length = 0
      await vi.advanceTimersByTimeAsync(PR_WAKE_POLL_MS)
      expect(reads).toEqual([PR])
      expect(getConversationSnooze('c')?.snoozedAt).not.toBeNull()
      reading = { ...reading!, changesRequestedAt: Date.now() }
      await vi.advanceTimersByTimeAsync(PR_WAKE_POLL_MS)
      expect(getConversationSnooze('c')).toMatchObject({ snoozedAt: null, wokeReason: 'pr' })
      expect(emitted().at(-1)).toMatchObject({ prSummary: 'PR #512: changes requested' })
      expect(host.pushWoke).toHaveBeenCalledWith('c', 'Chat', 'PR #512: changes requested')
      reads.length = 0
      await vi.advanceTimersByTimeAsync(3 * PR_WAKE_POLL_MS)
      expect(reads).toEqual([])
      expect(host.pushWoke).toHaveBeenCalledTimes(1)
    })

    it('reads one PR once for two chats, and a failed read tries again at the next tick', async () => {
      const s = withPr()
      await s.snooze('c', { until: null, pr: PR })
      await s.snooze('d', { until: T0 + 24 * HOUR, pr: PR })
      reads.length = 0
      reading = null
      await vi.advanceTimersByTimeAsync(PR_WAKE_POLL_MS)
      expect(reads).toEqual([PR])
      reading = { number: 512, state: 'open', headSha: 'b2', checksFailed: true, changesRequestedAt: null }
      await vi.advanceTimersByTimeAsync(PR_WAKE_POLL_MS)
      expect(reads).toEqual([PR, PR])
      expect(getConversationSnooze('c')?.wokeReason).toBe('pr')
      expect(getConversationSnooze('d')?.wokeReason).toBe('pr')
    })

    it('a merge first settles an idle chat by the merge rule, then wakes a busy one', async () => {
      const s = withPr()
      await s.snooze('c', { until: null, pr: PR })
      reading = { ...reading!, state: 'merged' }
      await vi.advanceTimersByTimeAsync(PR_WAKE_POLL_MS)
      expect(merged).toEqual(['c'])
      expect(getConversationSnooze('c')).toMatchObject({ wokeReason: 'pr' })
      expect(emitted().at(-1)).toMatchObject({ prSummary: 'PR #512 merged' })
    })

    it('a merge that settled the chat in between wakes nothing and sends no push', async () => {
      const s = withPr()
      await s.snooze('c', { until: null, pr: PR })
      host.settleMerged = (id) => void setConversationSettled(id, Date.now())
      reading = { ...reading!, state: 'merged' }
      await vi.advanceTimersByTimeAsync(PR_WAKE_POLL_MS)
      expect(getConversationSnooze('c')).toMatchObject({ snoozedAt: null, wokeAt: null })
      expect(host.pushWoke).not.toHaveBeenCalled()
    })

    it('checks the chat again after the PR read', async () => {
      const s = withPr()
      host.readPr = async () => {
        cards.add('c')
        return reading
      }
      expect(await s.snooze('c', { until: null, pr: PR })).toEqual({ ok: false, reason: 'needs_you' })
      s.dispose()
      cards.clear()
      expect(await s.snooze('c', { until: null, pr: PR })).toEqual({ ok: false, reason: 'no_row' })
    })

    it('never reads when no chat waits on a PR', async () => {
      const s = withPr()
      await s.snooze('c', { until: T0 + HOUR })
      await vi.advanceTimersByTimeAsync(3 * PR_WAKE_POLL_MS)
      expect(reads).toEqual([])
    })
  })

  it('a settle tells clients the snooze it ended, so its Undo can restore it', async () => {
    const s = make()
    await s.snooze('c', { until: T0 + HOUR })
    expect(storeConversationSettled(host, 'uuid-c', T0, 512)).toBe(true)
    const settled = host.emit.mock.calls.find(([c]) => c === AppChannels.CONVERSATION_SETTLED)?.[1]
    expect(settled).toMatchObject({ conversationId: 'c', prNumber: 512, endedSnooze: { until: T0 + HOUR, pr: null } })
    expect(getConversationSnooze('c')?.snoozedAt).toBeNull()
  })
})
