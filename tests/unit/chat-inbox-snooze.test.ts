/**
 * Snooze, Wake and their one Undo on the desktop (`services/chat-inbox.ts`):
 * clock-time presets keep the instant the menu showed, the undo is replaced
 * by any newer inbox action, dropped by a broadcast at another revision and
 * after 8 s, sends the revision it holds, and never restores a passed time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolvePresets, type ConversationSnoozedEvent, type SnoozeResult } from '../../src/shared/chat-snooze'

type SnoozeAnswer = SnoozeResult
const snoozeConversation = vi.fn(
  async (_id: string, request: { until: number | null; pr?: string | null }): Promise<SnoozeAnswer> => ({
    ok: true,
    until: request.until,
    pr: request.pr ?? null,
    rev: 5,
  }),
)
const unsnoozeConversation = vi.fn(
  async (_id: string, _expectRev?: number): Promise<{ ok: boolean; rev?: number }> => ({ ok: true, rev: 6 }),
)
const settleConversation = vi.fn(async () => ({ ok: true, settledAt: 1 }))
const markWokeSeen = vi.fn(async () => ({ ok: true }))
const track = vi.fn(async () => true)
vi.stubGlobal('window', {
  api: {
    app: { snoozeConversation, unsnoozeConversation, settleConversation, markWokeSeen },
    analytics: { track },
    routing: { bind: vi.fn(), supportsCapability: (_m: string, cap: string) => cap === 'chat_snooze_v1' },
  },
})

const inbox = await import('../../src/renderer/services/chat-inbox')
const { useAgentStore } = await import('../../src/renderer/stores/agent-store')
const { useSnoozeStore } = await import('../../src/renderer/stores/snooze-store')

const local = (h: number, m = 0, day = 2) => new Date(2026, 10, day, h, m).getTime()
const target = { id: 'c1', title: 'Debug auth callback', machineId: 'local' }
const option = (label: string, shownAt: number) => {
  const found = resolvePresets(new Date(shownAt)).find((o) => o.label === label)
  if (!found) throw new Error(`no ${label} at ${new Date(shownAt).toString()}`)
  return found
}
const event = (over: Partial<ConversationSnoozedEvent>): ConversationSnoozedEvent => ({
  conversationId: 'c1',
  snoozedUntil: null,
  snoozedAt: null,
  snoozePr: null,
  snoozeRev: 0,
  wokeAt: null,
  wokeReason: null,
  ...over,
})

beforeEach(() => {
  vi.useFakeTimers()
  useAgentStore.getState().setLastUndo(null)
  useAgentStore.getState().setInboxNotice(null)
  useSnoozeStore.setState({ byId: {} })
  snoozeConversation.mockClear()
  unsnoozeConversation.mockClear()
  track.mockClear()
})
afterEach(() => vi.useRealTimers())

describe('a menu left open', () => {
  it('sends the Tomorrow morning the menu showed, after midnight too', async () => {
    const shown = local(23, 50)
    const tomorrow = option('Tomorrow morning', shown)
    expect(tomorrow.at).toBe(local(9, 0, 3))
    expect(await inbox.snoozeChat(target, { option: tomorrow }, 'row', local(0, 10, 3))).toBe(true)
    expect(snoozeConversation).toHaveBeenCalledWith('c1', {
      until: local(9, 0, 3),
      pr: null,
      preset: 'tomorrow_morning',
      surface: 'row',
    })
  })

  it('refuses Tonight once 20:00 has passed, with a notice, and picks no other day', async () => {
    const tonight = option('Tonight', local(17, 40))
    expect(await inbox.snoozeChat(target, { option: tonight }, 'row', local(21, 5))).toBe(false)
    expect(snoozeConversation).not.toHaveBeenCalled()
    expect(useAgentStore.getState().inboxNotice).toBe('Tonight has passed. Pick another time')
    expect(useAgentStore.getState().lastUndo).toBeNull()
  })

  it('counts Later today from the click, across 21:00', async () => {
    const later = option('Later today', local(17, 20))
    expect(later.at).toBe(local(20, 30))
    await inbox.snoozeChat(target, { option: later }, 'palette', local(21, 5))
    expect(snoozeConversation.mock.calls[0][1]).toMatchObject({ until: local(0, 30, 3), preset: 'later_today' })
  })
})

describe('snooze', () => {
  it('refuses a chat that needs the user, as the backend would', async () => {
    expect(await inbox.snoozeChat({ ...target, needsYou: true }, { pr: 'github:a/b#1' }, 'palette')).toBe(false)
    expect(snoozeConversation).not.toHaveBeenCalled()
    expect(useAgentStore.getState().inboxNotice).toBe('A chat that needs you cannot be snoozed')
  })

  it('moves the row at once, offers Undo, and takes the revision from the answer', async () => {
    const tomorrow = option('Tomorrow morning', local(10))
    const done = inbox.snoozeChat(target, { option: tomorrow }, 'row', local(10))
    expect(useSnoozeStore.getState().byId.c1?.snoozedAt).toBe(local(10))
    expect(useAgentStore.getState().lastUndo).toMatchObject({ kind: 'snooze', id: 'c1', until: tomorrow.at })
    await done
    expect(useAgentStore.getState().lastUndo).toMatchObject({ rev: 5 })
    expect(useSnoozeStore.getState().byId.c1?.snoozeRev).toBe(5)
  })

  it('puts the row back and says why when the backend refuses', async () => {
    snoozeConversation.mockImplementationOnce(async () => ({ ok: false, reason: 'needs_you' }))
    await inbox.snoozeChat(target, { pr: 'github:a/b#1' }, 'row')
    expect(useSnoozeStore.getState().byId.c1?.snoozedAt).toBeNull()
    expect(useAgentStore.getState().lastUndo).toBeNull()
    expect(useAgentStore.getState().inboxNotice).toBe('A chat that needs you cannot be snoozed')
  })

  it('keeps a newer broadcast when the backend refuses after it', async () => {
    snoozeConversation.mockImplementationOnce(async () => {
      inbox.applySnoozedEvent(event({ conversationId: 'r1', snoozedAt: 7, snoozePr: 'github:a/b#2', snoozeRev: 3 }))
      return { ok: false, reason: 'stale' }
    })
    await inbox.snoozeChat({ ...target, id: 'r1' }, { pr: 'github:a/b#1' }, 'row')
    expect(useSnoozeStore.getState().byId.r1).toMatchObject({ snoozedAt: 7, snoozePr: 'github:a/b#2', snoozeRev: 3 })
    expect(useAgentStore.getState().lastUndo).toBeNull()
    expect(useAgentStore.getState().inboxNotice).toBe('The chat changed since. Nothing to undo')
  })
})

describe('wake', () => {
  it('counts as done when the backend sends no revision, and offers no Undo it could not send', async () => {
    useSnoozeStore.getState().patch('w1', { snoozedAt: 1, snoozedUntil: local(20), snoozeRev: 2 })
    unsnoozeConversation.mockImplementationOnce(async () => ({ ok: true }))
    expect(await inbox.wakeChat({ ...target, id: 'w1' })).toBe(true)
    expect(useSnoozeStore.getState().byId.w1?.snoozedAt).toBeNull()
    expect(useAgentStore.getState().lastUndo).toBeNull()
  })
})

describe('the one Undo', () => {
  it('is replaced by any newer inbox action on any chat', async () => {
    await inbox.snoozeChat(target, { pr: 'github:a/b#1' }, 'row')
    await inbox.settleChat({ id: 'c2', title: 'Other', machineId: 'local' })
    expect(useAgentStore.getState().lastUndo).toMatchObject({ kind: 'settle', id: 'c2' })
  })

  it('is withdrawn after 8 s', async () => {
    await inbox.snoozeChat(target, { pr: 'github:a/b#1' }, 'row')
    vi.advanceTimersByTime(inbox.INBOX_UNDO_MS - 1)
    expect(useAgentStore.getState().lastUndo).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(useAgentStore.getState().lastUndo).toBeNull()
  })

  it('is dropped by a broadcast for that chat at another revision', async () => {
    await inbox.snoozeChat(target, { pr: 'github:a/b#1' }, 'row')
    // Its own broadcast (rev 5) keeps it; a PR wake (rev 6) drops it.
    inbox.applySnoozedEvent(event({ snoozedAt: 1, snoozePr: 'github:a/b#1', snoozeRev: 5 }))
    expect(useAgentStore.getState().lastUndo).not.toBeNull()
    inbox.applySnoozedEvent(event({ snoozeRev: 6, wokeAt: 2, wokeReason: 'pr', prSummary: 'PR #1 merged' }))
    expect(useAgentStore.getState().lastUndo).toBeNull()
    expect(useSnoozeStore.getState().byId.c1).toMatchObject({ wokeReason: 'pr', wokePrSummary: 'PR #1 merged' })
  })

  it('is dropped when a newer revision was broadcast before the answer came', async () => {
    snoozeConversation.mockImplementationOnce(async (_id, request) => {
      inbox.applySnoozedEvent(event({ snoozeRev: 9 }))
      return { ok: true, until: request.until, pr: null, rev: 8 }
    })
    await inbox.snoozeChat({ ...target, id: 'c1' }, { option: option('Next week', local(10)) }, 'row', local(10))
    expect(useAgentStore.getState().lastUndo).toBeNull()
    // The older answer does not replace what the broadcast showed.
    expect(useSnoozeStore.getState().byId.c1).toMatchObject({ snoozeRev: 9, snoozedUntil: null })
  })

  it('of a snooze sends the revision, and says so when the backend finds it stale', async () => {
    await inbox.snoozeChat({ ...target, id: 'u0' }, { pr: 'github:a/b#1' }, 'row')
    unsnoozeConversation.mockImplementationOnce(async () => ({ ok: false }))
    expect(inbox.undoLastInbox()).toBe('u0')
    await vi.waitFor(() => expect(unsnoozeConversation).toHaveBeenCalledWith('u0', 5))
    await vi.waitFor(() => expect(useAgentStore.getState().inboxNotice).toBe('The chat changed since. Nothing to undo'))
    expect(useSnoozeStore.getState().byId.u0?.snoozePr).toBe('github:a/b#1')
    expect(track).toHaveBeenCalledWith('snooze_undone', { kind: 'snooze' })
  })

  it('of a Wake snoozes again to the same time with the revision', async () => {
    useSnoozeStore
      .getState()
      .patch('u1', { snoozedAt: local(9), snoozedUntil: local(20), snoozePr: null, snoozeRev: 4 })
    await inbox.wakeChat({ ...target, id: 'u1' })
    expect(useSnoozeStore.getState().byId.u1?.snoozedAt).toBeNull()
    expect(useAgentStore.getState().lastUndo).toMatchObject({ kind: 'wake', until: local(20), rev: 6 })
    expect(inbox.undoLastInbox(local(19))).toBe('u1')
    await vi.waitFor(() =>
      expect(snoozeConversation).toHaveBeenCalledWith('u1', { until: local(20), pr: null, expectRev: 6 }),
    )
    expect(track).toHaveBeenCalledWith('snooze_undone', { kind: 'wake' })
  })

  it('of a Wake does not restore a time that has passed', async () => {
    useSnoozeStore
      .getState()
      .patch('u2', { snoozedAt: local(9), snoozedUntil: local(20), snoozePr: null, snoozeRev: 4 })
    await inbox.wakeChat({ ...target, id: 'u2' })
    expect(inbox.undoLastInbox(local(20, 1))).toBeNull()
    expect(snoozeConversation).not.toHaveBeenCalled()
    expect(useAgentStore.getState().inboxNotice).toBe('The snooze time has passed. Nothing to undo')
  })

  it('of a Wake whose time passed keeps only its PR', async () => {
    useSnoozeStore
      .getState()
      .patch('u3', { snoozedAt: local(9), snoozedUntil: local(20), snoozePr: 'github:a/b#1', snoozeRev: 4 })
    await inbox.wakeChat({ ...target, id: 'u3' })
    inbox.undoLastInbox(local(21))
    await vi.waitFor(() =>
      expect(snoozeConversation).toHaveBeenCalledWith('u3', { until: null, pr: 'github:a/b#1', expectRev: 6 }),
    )
  })
})

describe('the Woke marker', () => {
  it('clears on open, here and on the backend', () => {
    useSnoozeStore.getState().patch('c1', { snoozedAt: null, wokeAt: 5, wokeReason: 'time' })
    inbox.noteChatOpened('c1')
    expect(useSnoozeStore.getState().byId.c1?.wokeAt).toBeNull()
    expect(markWokeSeen).toHaveBeenCalledWith('c1')
  })

  it('clears on settle', async () => {
    useSnoozeStore.getState().patch('c1', { snoozedAt: null, wokeAt: 5, wokeReason: 'time' })
    await inbox.settleChat(target)
    expect(useSnoozeStore.getState().byId.c1?.wokeAt).toBeNull()
  })

  it('comes back when the settle fails', async () => {
    useSnoozeStore.getState().patch('m1', { snoozedAt: null, wokeAt: 5, wokeReason: 'time' })
    settleConversation.mockImplementationOnce(async () => {
      throw new Error('offline')
    })
    expect(await inbox.settleChat({ ...target, id: 'm1' })).toBe(false)
    expect(useSnoozeStore.getState().byId.m1).toMatchObject({ wokeAt: 5, wokeReason: 'time' })
  })

  it('stays as a broadcast left it when the settle fails after it', async () => {
    useSnoozeStore.getState().patch('m2', { snoozedAt: null, wokeAt: 5, wokeReason: 'time' })
    settleConversation.mockImplementationOnce(async () => {
      inbox.applySnoozedEvent(event({ conversationId: 'm2', snoozedAt: 8, snoozedUntil: local(20), snoozeRev: 4 }))
      throw new Error('offline')
    })
    expect(await inbox.settleChat({ ...target, id: 'm2' })).toBe(false)
    expect(useSnoozeStore.getState().byId.m2).toMatchObject({ wokeAt: null, snoozedAt: 8 })
  })

  it('does nothing for a chat that is not woke', () => {
    markWokeSeen.mockClear()
    inbox.noteChatOpened('none')
    expect(markWokeSeen).not.toHaveBeenCalled()
  })
})

describe('remote machines', () => {
  it('offer Snooze only when their backend announced it', () => {
    expect(inbox.machineSupportsSnooze('local', 'chat_snooze_v1')).toBe(true)
    expect(inbox.machineSupportsSnooze('vm', 'chat_snooze_v1')).toBe(true)
    expect(inbox.machineSupportsSnooze('vm', 'other')).toBe(false)
  })
})
