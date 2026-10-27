/**
 * Wakes: what a parent hears about its children. A child's `report_to_hub`,
 * and Switchboard's own failed and blocked notes, are `hub_wakes` rows of a
 * summary and a pointer into the child's transcript, never a report body.
 *
 * The scheduler sends them to the parent as ONE turn while it is idle, after
 * 15 s with no newer wake (`wakeBatchDecision`), through the approval result
 * path (no `turnDepth`, no link renewal). A wake is delivered only once the
 * provider shows activity on that turn; a refused send, or a turn with no
 * activity for 2 minutes (which is ended), leaves its wakes pending for one
 * more try. A second failure, or more than 30 wake turns in an hour, holds
 * them until Deliver or the user's next message to the parent, which carries
 * every pending wake along (`claimForTurn`).
 *
 * Measured: one `hub.wake` perf line per wake turn (wakes, children, bytes of
 * the turn, attempt, outcome, ms to the first activity), threshold 0.
 */
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  HUB_WAKE_MAX_ATTEMPTS,
  HUB_WAKE_NO_START_MS,
  HUB_WAKE_QUIET_MS,
  formatHubUpdateMarker,
  hubUpdateTurn,
  wakeBatchDecision,
  wakeChildState,
  type HubPointer,
  type HubUpdateEntry,
  type HubUpdateRowEntry,
  type HubWakeKind,
} from '@shared/hub'
import {
  getHubChild,
  getHubParent,
  insertHubWake,
  listParentsWithPendingHubWakes,
  listPendingHubWakes,
  markHubWakesDelivered,
  resolveRootThreadId,
  setHubParentHeld,
  type HubWakeRow,
} from '../db/database'
import { createMainLogger } from '../logger'
import { perfSpan } from '../perf'

const log = createMainLogger('hub:wakes')

const HOUR_MS = 60 * 60_000

export interface HubWakeHost {
  /** The `hub_children` flag. Off: wakes are kept and nothing is sent. */
  enabled(): boolean
  /** The id the parent's session runs under, or null when it is not running. */
  liveThread(parentId: string): string | null
  /** No turn running, being prepared or starting, and no profile switch under way. */
  idle(threadId: string): boolean
  /** Sends the update as a result turn; false when the adapter refused it. */
  send(threadId: string, body: string, requestId: string): Promise<boolean>
  /** Ends a wake turn that never started. */
  interrupt(threadId: string): Promise<void>
  /** Stores and shows the `[[sb:hub-update]]` row in the parent's chat. */
  announce(parentId: string, content: string): void
  /** The parent's view changed (a hold set or lifted). */
  changed(parentId: string): void
}

interface InFlight {
  threadId: string
  ids: string[]
  rows: HubUpdateRowEntry[]
  sentAt: number
  /** The provider showed activity on the turn. */
  active: boolean
  /** The send call returned true. */
  sent: boolean
  noStart: ReturnType<typeof setTimeout> | null
  span: ReturnType<typeof perfSpan>
}

/** A user turn's claim on the parent's pending wakes (`AtomicUserTurnSubmission`'s dispatch hooks). */
export interface HubWakeClaim {
  apply(providerText: string): string
  release(): void
  dispatched(): {
    commitInTransaction: (db: Database.Database, acceptedAt: number) => void
    afterCommit: (committed: boolean) => void
  }
}

const newWakeId = () => `hw_${Date.now()}_${randomBytes(4).toString('hex')}`

/** The update turn and the row for these wakes, in wake order. */
function describe(wakes: readonly HubWakeRow[]): { body: string; rows: HubUpdateRowEntry[]; children: number } {
  const titles = new Map<string, string>()
  const titleOf = (childId: string) => {
    if (!titles.has(childId)) titles.set(childId, getHubChild(childId)?.title ?? 'Child chat')
    return titles.get(childId)!
  }
  const entries: HubUpdateEntry[] = wakes.map((w) => ({
    title: titleOf(w.childId),
    state: wakeChildState(w.kind),
    summary: w.summary,
    pointer: w.pointer ?? { childId: w.childId, at: w.createdAt },
  }))
  const rows = wakes.map((w) => ({ childId: w.childId, title: titleOf(w.childId), kind: w.kind, summary: w.summary }))
  return { body: hubUpdateTurn(entries), rows, children: titles.size }
}

export class HubWakeScheduler {
  /** Parents with pending wakes, by root id: the event hook reads nothing else while it is empty. */
  private readonly pending = new Set<string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly inFlight = new Map<string, InFlight>()
  /** Wake ids a user turn is carrying, until its commit settles. */
  private readonly claimed = new Set<string>()
  private readonly failures = new Map<string, number>()
  /** Send times of wake turns in the last hour, per parent. In memory: a restart starts a new hour. */
  private readonly sends = new Map<string, number[]>()
  /** Wake turns being sent, by the thread they went to. */
  private readonly byThread = new Map<string, string>()

  constructor(
    private readonly host: HubWakeHost,
    private readonly now: () => number = Date.now,
  ) {}

  /** Parents with wakes left from before a restart; each is sent once its session runs and idles. */
  start(): void {
    try {
      for (const id of listParentsWithPendingHubWakes()) this.pending.add(id)
    } catch (err) {
      log.warn('could not read pending wakes', err)
    }
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    for (const f of this.inFlight.values()) if (f.noStart) clearTimeout(f.noStart)
  }

  /** Stores a wake and schedules its parent. */
  record(w: { parentId: string; childId: string; kind: HubWakeKind; summary: string; pointer: HubPointer | null }): void {
    insertHubWake({ id: newWakeId(), ...w })
    this.poke(w.parentId)
  }

  /** Looks at a parent again: a new wake, its turn ended, its session started. Any id of its thread. */
  poke(threadId: string): void {
    const parentId = resolveRootThreadId(threadId)
    this.pending.add(parentId)
    this.consider(parentId)
  }

  /** A chat's turn ended or its status changed: a cheap no-op unless it is a parent with pending wakes. */
  onIdleChance(threadId: string): void {
    if (this.pending.size === 0) return
    const parentId = resolveRootThreadId(threadId)
    if (this.pending.has(parentId)) this.consider(parentId)
  }

  /** Provider activity on a thread: confirms a wake turn sent there. */
  onActivity(threadId: string): void {
    const parentId = this.byThread.get(threadId)
    if (!parentId) return
    const f = this.inFlight.get(parentId)
    if (!f || f.active) return
    f.active = true
    if (f.sent) this.delivered(parentId, f)
  }

  /** Deliver: lifts the hold and sends what is pending at the parent's next idle, past the hourly budget. */
  deliverHeld(threadId: string): void {
    const parentId = resolveRootThreadId(threadId)
    setHubParentHeld(parentId, false)
    this.failures.delete(parentId)
    this.sends.delete(parentId)
    this.host.changed(parentId)
    this.poke(parentId)
  }

  /**
   * The parent's pending wakes, carried on the user's turn to it. They are
   * delivered in the turn's own commit, and a held parent is released after it.
   */
  claimForTurn(threadId: string): HubWakeClaim | null {
    if (this.pending.size === 0) return null
    const parentId = resolveRootThreadId(threadId)
    if (!this.pending.has(parentId) || this.inFlight.has(parentId)) return null
    let wakes: HubWakeRow[]
    try {
      wakes = listPendingHubWakes(parentId).filter((w) => !this.claimed.has(w.id))
    } catch (err) {
      log.warn(`could not read the pending wakes of ${parentId}; the turn goes without them`, err)
      return null
    }
    if (wakes.length === 0) return null
    for (const w of wakes) this.claimed.add(w.id)
    const { body, rows } = describe(wakes)
    let open = true
    const release = () => {
      if (!open) return
      open = false
      for (const w of wakes) this.claimed.delete(w.id)
    }
    return {
      apply: (providerText) => `${providerText}\n\n${body}`,
      release,
      dispatched: () => ({
        commitInTransaction: (db, acceptedAt) => {
          markHubWakesDelivered(
            wakes.map((w) => w.id),
            acceptedAt,
            db,
          )
        },
        afterCommit: (committed) => {
          release()
          if (!committed) {
            this.consider(parentId)
            return
          }
          log.info('wakes carried on a user turn', { parentId, wakes: wakes.length, bytes: Buffer.byteLength(body) })
          this.host.announce(parentId, formatHubUpdateMarker(rows))
          if (getHubParent(parentId)?.held) setHubParentHeld(parentId, false)
          this.failures.delete(parentId)
          this.host.changed(parentId)
          this.consider(parentId)
        },
      }),
    }
  }

  private consider(parentId: string): void {
    if (!this.host.enabled() || this.inFlight.has(parentId)) return
    const timer = this.timers.get(parentId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(parentId)
    }
    let wakes: HubWakeRow[]
    let held: boolean
    try {
      wakes = listPendingHubWakes(parentId).filter((w) => !this.claimed.has(w.id))
      held = getHubParent(parentId)?.held ?? false
    } catch (err) {
      log.warn(`could not read the wakes of ${parentId}`, err)
      return
    }
    if (wakes.length === 0) {
      // A user turn carrying them may still fail; its afterCommit looks again.
      if (this.claimed.size === 0) this.pending.delete(parentId)
      return
    }
    const now = this.now()
    const live = this.host.liveThread(parentId)
    const decision = wakeBatchDecision({
      pending: wakes.length,
      newestAt: Math.max(0, ...wakes.map((w) => w.createdAt)),
      now,
      parentIdle: live !== null && this.host.idle(live),
      held,
      sentInLastHour: this.recentSends(parentId, now),
    })
    if (decision.action === 'wait') {
      if (decision.until !== null)
        this.timers.set(
          parentId,
          setTimeout(() => this.consider(parentId), decision.until - now),
        )
      return
    }
    if (decision.action === 'hold') {
      if (decision.reason === 'budget') this.hold(parentId, 'budget', wakes.length)
      return
    }
    void this.send(parentId, live!, wakes)
  }

  private recentSends(parentId: string, now: number): number {
    const kept = (this.sends.get(parentId) ?? []).filter((t) => now - t < HOUR_MS)
    this.sends.set(parentId, kept)
    return kept.length
  }

  private hold(parentId: string, reason: 'budget' | 'no_start', wakes: number): void {
    log.info('wakes held', { parentId, reason, wakes })
    try {
      setHubParentHeld(parentId, true, reason)
    } catch (err) {
      log.warn(`could not hold the wakes of ${parentId}`, err)
    }
    this.host.changed(parentId)
  }

  private async send(parentId: string, threadId: string, wakes: HubWakeRow[]): Promise<void> {
    const { body, rows, children } = describe(wakes)
    const attempt = (this.failures.get(parentId) ?? 0) + 1
    const f: InFlight = {
      threadId,
      ids: wakes.map((w) => w.id),
      rows,
      sentAt: this.now(),
      active: false,
      sent: false,
      noStart: null,
      span: perfSpan('hub.wake', {
        parentId,
        wakes: wakes.length,
        children,
        bytes: Buffer.byteLength(body),
        attempt,
      }),
    }
    // Before the send: a Codex turn can show activity before its start call returns.
    this.inFlight.set(parentId, f)
    this.byThread.set(threadId, parentId)
    let ok = false
    try {
      ok = await this.host.send(threadId, body, `hub-wake-${randomBytes(6).toString('hex')}`)
    } catch (err) {
      log.warn(`wake turn to ${parentId} threw`, err)
    }
    if (this.inFlight.get(parentId) !== f) return
    if (!ok) {
      this.failed(parentId, f, 'refused')
      return
    }
    f.sent = true
    if (f.active) {
      this.delivered(parentId, f)
      return
    }
    f.noStart = setTimeout(() => void this.noStart(parentId, f), HUB_WAKE_NO_START_MS)
  }

  private delivered(parentId: string, f: InFlight): void {
    this.settle(parentId, f)
    try {
      markHubWakesDelivered(f.ids, f.sentAt)
    } catch (err) {
      log.error(`could not mark the wakes of ${parentId} delivered; they may be sent again`, err)
    }
    f.span.end({ outcome: 'delivered', startMs: this.now() - f.sentAt })
    this.failures.delete(parentId)
    this.sends.set(parentId, [...(this.sends.get(parentId) ?? []), this.now()])
    this.host.announce(parentId, formatHubUpdateMarker(f.rows))
    this.host.changed(parentId)
    // Wakes that came in while this one was out.
    this.consider(parentId)
  }

  private async noStart(parentId: string, f: InFlight): Promise<void> {
    if (this.inFlight.get(parentId) !== f || f.active) return
    log.warn('wake turn showed no activity; ending it', { parentId, threadId: f.threadId })
    await this.host.interrupt(f.threadId).catch((err) => log.warn(`could not end the wake turn of ${parentId}`, err))
    this.failed(parentId, f, 'no_start')
  }

  private failed(parentId: string, f: InFlight, outcome: 'refused' | 'no_start'): void {
    this.settle(parentId, f)
    f.span.end({ outcome })
    const n = (this.failures.get(parentId) ?? 0) + 1
    this.failures.set(parentId, n)
    if (n >= HUB_WAKE_MAX_ATTEMPTS) {
      this.failures.delete(parentId)
      this.hold(parentId, 'no_start', f.ids.length)
      return
    }
    // One more try after the quiet time, or at the parent's next idle.
    this.timers.set(
      parentId,
      setTimeout(() => this.consider(parentId), HUB_WAKE_QUIET_MS),
    )
  }

  private settle(parentId: string, f: InFlight): void {
    if (f.noStart) clearTimeout(f.noStart)
    this.inFlight.delete(parentId)
    if (this.byThread.get(f.threadId) === parentId) this.byThread.delete(f.threadId)
  }
}
