/**
 * Snooze timers and wakes (`shared/chat-snooze.ts` holds the rules). One per
 * backend: the desktop builds it in `main/index.ts`, the headless server in
 * `server/index.ts`. Every change is written to the chat's row first, then
 * broadcast on `app:conversation-snoozed`, so a client that missed the
 * broadcast reads the same state from its next session list.
 *
 * Timers are rebuilt from the rows on `start()`, on `resync()` (every
 * 5 minutes, and on the desktop when the Mac wakes), so a snooze that ended
 * while the app was closed or the laptop slept wakes on the next pass. A timer
 * carries the row's revision; a fire whose revision moved does nothing.
 */
import { AppChannels } from '@shared/ipc-channels'
import type { ConversationSettledEvent } from '@shared/chat-settle'
import {
  checkWakeTime,
  MARKED_WAKE_REASONS,
  shouldWakeOn,
  type ConversationSnoozedEvent,
  type InboxEvent,
  type SnoozeRequest,
  type SnoozeResult,
  type WakeReason,
} from '@shared/chat-snooze'
import {
  clearConversationWoke,
  getConversationSnooze,
  getConversationTitle,
  isConversationArchived,
  listSnoozedConversations,
  listWokeConversationIds,
  resolveRootThreadId,
  setConversationSnooze,
  wakeConversation,
  type SnoozedConversationRow,
} from '../db/database'
import { onConversationArchived } from '../db/archive-events'
import { createMainLogger } from '../logger'

const log = createMainLogger('conversations:snooze')

/** setTimeout's ceiling; a later wake fires early, finds it early and sets the next timer. */
const MAX_TIMER_MS = 2 ** 31 - 1
export const SNOOZE_RESYNC_MS = 5 * 60_000

export interface ChatSnoozeHost {
  emit(channel: string, payload: unknown): void
  /** An approval, question or plan waits in the chat. */
  needsYou(conversationId: string): boolean
  /** One push for a wake the user asked for (time, PR); `line` says why. */
  pushWoke?(conversationId: string, title: string, line: string): void
}

export class ChatSnoozer {
  private readonly timers = new Map<string, { timer: ReturnType<typeof setTimeout>; until: number; rev: number }>()
  /** Root ids snoozed now, with or without a time. */
  private readonly snoozed = new Set<string>()
  /** Root ids that show the Woke marker, so a write that clears it is broadcast. */
  private readonly woke = new Set<string>()
  private resyncTimer: ReturnType<typeof setInterval> | null = null
  private stopArchiveListener: (() => void) | null = null

  constructor(
    private readonly host: ChatSnoozeHost,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.resync()
    this.resyncTimer ??= setInterval(() => this.resync(), SNOOZE_RESYNC_MS)
    this.resyncTimer.unref?.()
    this.stopArchiveListener ??= onConversationArchived((id) => this.onCleared(id))
  }

  /** Rebuild one timer per snoozed row with a time. A time already past fires now. */
  resync(): void {
    let rows: SnoozedConversationRow[]
    try {
      rows = listSnoozedConversations()
      this.woke.clear()
      for (const id of listWokeConversationIds()) this.woke.add(id)
    } catch (err) {
      log.warn('could not read snoozed chats', err)
      return
    }
    this.snoozed.clear()
    for (const row of rows) this.snoozed.add(row.id)
    for (const id of this.timers.keys()) if (!this.snoozed.has(id)) this.clearTimer(id)
    for (const row of rows) {
      const set = this.timers.get(row.id)
      // A timer already set for this time and revision stands.
      if (row.snoozedUntil != null && (set?.until !== row.snoozedUntil || set.rev !== row.snoozeRev))
        this.schedule(row.id, row.snoozedUntil, row.snoozeRev)
      if (row.snoozedUntil == null) this.clearTimer(row.id)
    }
  }

  dispose(): void {
    for (const { timer } of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    if (this.resyncTimer) clearInterval(this.resyncTimer)
    this.resyncTimer = null
    this.stopArchiveListener?.()
    this.stopArchiveListener = null
  }

  snooze(id: string, request: SnoozeRequest): SnoozeResult {
    const root = resolveRootThreadId(id)
    const now = this.now()
    const until = request.until ?? null
    const pr = request.pr ?? null
    if (until === null && pr === null) return { ok: false, reason: 'empty' }
    if (until !== null) {
      const check = checkWakeTime(until, now)
      if (check !== 'ok') return { ok: false, reason: check }
      // An Undo restores only a time still ahead; the grace is for a slow click.
      if (request.expectRev !== undefined && until <= now) return { ok: false, reason: 'past' }
    }
    if (isConversationArchived(root)) return { ok: false, reason: 'no_row' }
    // An open card would wake it at once.
    if (this.host.needsYou(root)) return { ok: false, reason: 'needs_you' }
    const written = setConversationSnooze(root, { until, pr, prMark: null, at: now, expectRev: request.expectRev })
    if (written === null) return { ok: false, reason: getConversationSnooze(root) ? 'stale' : 'no_row' }
    const { rev, unsettled } = written
    this.clearTimer(root)
    this.snoozed.add(root)
    this.woke.delete(root)
    if (until !== null) this.schedule(root, until, rev)
    const title = this.broadcast(root)
    // The write cleared the settle; clients drop it the way an unsettle does.
    if (unsettled) {
      const settled: ConversationSettledEvent = { conversationId: root, settledAt: null, ...(title ? { title } : {}) }
      this.host.emit(AppChannels.CONVERSATION_SETTLED, settled)
    }
    return { ok: true, until, pr, rev }
  }

  /**
   * End a snooze. `wake_now`, `undo`, `turn`, `settle` and `archive` leave no
   * marker. With `expectRev`, only while the chat is at that revision.
   */
  wake(id: string, reason: WakeReason, opts: { expectRev?: number; prSummary?: string } = {}): boolean {
    const root = resolveRootThreadId(id)
    if (!wakeConversation(root, reason, this.now(), opts.expectRev)) return false
    this.forget(root)
    if (MARKED_WAKE_REASONS.includes(reason)) this.woke.add(root)
    const title = this.broadcast(root, opts.prSummary)
    log.info('chat woke', { id: root, reason })
    if (reason === 'time' || reason === 'pr')
      this.host.pushWoke?.(root, title ?? 'Switchboard', opts.prSummary ?? 'Snooze ended')
    return true
  }

  /** Something happened in a chat: wake it when the rules say so. Never throws into the caller. */
  onEvent(id: string, event: InboxEvent): void {
    try {
      const state = getConversationSnooze(id)
      if (!state) return
      const reason = shouldWakeOn(event, state)
      if (reason) this.wake(id, reason, { expectRev: state.snoozeRev })
    } catch (err) {
      log.warn(`snooze wake check for ${id} failed`, err)
    }
  }

  /** The user opened a woken chat. */
  seen(id: string): boolean {
    const root = resolveRootThreadId(id)
    if (!clearConversationWoke(root)) return false
    this.woke.delete(root)
    this.broadcast(root)
    return true
  }

  /**
   * A user turn, a settle or an archive already ended the snooze and the
   * marker in its own write (`clearConversationInboxForTurn`,
   * `setConversationSettled`, `archiveConversation`); tell clients and drop
   * the timer.
   */
  onCleared(id: string): void {
    const root = resolveRootThreadId(id)
    if (!this.snoozed.has(root) && !this.woke.has(root)) return
    this.forget(root)
    this.woke.delete(root)
    this.broadcast(root)
  }

  private schedule(id: string, until: number, rev: number): void {
    this.clearTimer(id)
    const delay = Math.min(Math.max(0, until - this.now()), MAX_TIMER_MS)
    const timer = setTimeout(() => this.fire(id, until, rev), delay)
    timer.unref?.()
    this.timers.set(id, { timer, until, rev })
  }

  private fire(id: string, until: number, rev: number): void {
    this.timers.delete(id)
    try {
      const state = getConversationSnooze(id)
      // Re-snoozed, woken or cleared since this timer was set.
      if (!state || state.snoozeRev !== rev || state.snoozedUntil !== until) return
      if (this.now() < until) return this.schedule(id, until, rev)
      this.wake(id, 'time', { expectRev: rev })
    } catch (err) {
      log.warn(`snooze timer for ${id} failed`, err)
    }
  }

  private forget(id: string): void {
    this.snoozed.delete(id)
    this.clearTimer(id)
  }

  private clearTimer(id: string): void {
    const set = this.timers.get(id)
    if (set) clearTimeout(set.timer)
    this.timers.delete(id)
  }

  /** Send the row's state to every client. Returns the title. */
  private broadcast(id: string, prSummary?: string): string | undefined {
    const state = getConversationSnooze(id)
    if (!state) return undefined
    const title = getConversationTitle(id) ?? undefined
    const { snoozePrMark: _mark, ...snooze } = state
    const event: ConversationSnoozedEvent = {
      conversationId: id,
      ...snooze,
      ...(title ? { title } : {}),
      ...(prSummary ? { prSummary } : {}),
    }
    this.host.emit(AppChannels.CONVERSATION_SNOOZED, event)
    return title
  }
}

let active: ChatSnoozer | null = null

/** Build and start this backend's snoozer. A second call replaces the first. */
export function startChatSnoozer(host: ChatSnoozeHost): ChatSnoozer {
  active?.dispose()
  active = new ChatSnoozer(host)
  active.start()
  return active
}

/** This backend's snoozer, or null before `startChatSnoozer` (tests, a host without one). */
export function chatSnoozer(): ChatSnoozer | null {
  return active
}
