/**
 * Auto-resume after a usage limit, for every chat (flag `limit_auto_resume`).
 *
 * A turn that ends on a usage limit with a reset time arms the chat's
 * `limit_resumes` row and one timer at the reset plus a minute. The fire runs
 * the checks of `fireChecks` (with a fresh usage reading), sends the resume
 * turn, then lets the held queue run behind it. A resumed turn that fails or
 * hits the limit again within 5 minutes counts in the streak; the third gives
 * up. Stop, archive and Cancel disarm the row durably. The rules are pure, in
 * `shared/limit-resume.ts`; this module holds the timers and the I/O.
 *
 * Keyed by the ROOT conversation id. The registry passes live session ids,
 * which `resolveRootThreadId` maps back.
 */
import { randomUUID } from 'node:crypto'
import {
  armLimitResume,
  disarmLimitResume,
  getLimitResume,
  listArmedLimitResumes,
  markLimitResumeFired,
  resolveRootThreadId,
  setLimitResumeStreak,
  type LimitResumeRow,
} from '../db/database'
import {
  fireChecks,
  limitState,
  nextStreak,
  shouldArm,
  LIMIT_RESUME_FIRE_DELAY_MS,
  type ArmDecision,
  type LimitDisarmReason,
  type LimitState,
  type TurnLimit,
  type UsageProbe,
} from '@shared/limit-resume'
import type { ProviderUsage } from '@shared/provider-usage'
import { createMainLogger } from '../logger'
import { perfSpan } from '../perf'

const log = createMainLogger('provider:limit-resume')

/** How long a fire that waits for an open card, or for a failed send, tries again after. */
const RETRY_MS = 5 * 60_000
/** A second end with the same reset this soon after a limit is the same turn (a Claude rejection, then its late empty result). */
const SAME_LIMIT_MS = 30_000
/** setTimeout's ceiling; a later reset fires early, finds it early and sets the next timer. */
const MAX_TIMER_MS = 2 ** 31 - 1

export interface LimitResumeHost {
  /** The flag `limit_auto_resume`. Off: nothing arms or fires. */
  enabled(): boolean
  /** Settings, Accounts: `chats.autoResumeAfterLimit`. */
  settingOn(): boolean
  /** The id the chat's session runs under now, or null when it is not running. */
  liveThread(conversationId: string): string | null
  /** A turn runs, or is being prepared, on this live session. */
  busy(threadId: string): boolean
  /** An approval, question or plan waits for the user. */
  needsYou(threadId: string): boolean
  /** The provider instance the live session runs on. */
  instanceOf(threadId: string): string | null
  archived(conversationId: string): boolean
  usage(instanceId: string): Promise<ProviderUsage>
  /** Send the resume turn, then release the held queue behind it. False when not sent. */
  sendResume(threadId: string): Promise<boolean>
  /** Tell clients the chat's Limited row changed. `resumed` when a resume turn was just sent. */
  changed(conversationId: string, state: LimitState, resumed: boolean): void
}

/** Whether a reading says the account can run a turn now. A reading we cannot use counts as open: the turn is the test. */
export function usageProbe(usage: ProviderUsage, now: number): UsageProbe {
  if (usage.status !== 'ok') return { open: true }
  const full = usage.windows.filter(
    (w) => (w.reached || (w.usedPercent ?? 0) >= 100) && (w.resetsAtMs === null || w.resetsAtMs > now),
  )
  if (full.length === 0) return { open: true }
  const resets = full.map((w) => w.resetsAtMs).filter((ms): ms is number => ms !== null)
  return { open: false, resetAt: resets.length > 0 ? Math.max(...resets) : null }
}

export type ResumeNowResult = { ok: true } | { ok: false; message: string }

export class LimitResumer {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Chats whose last turn ended on a usage limit: that turn's id and why it did not arm. */
  private readonly limited = new Map<
    string,
    { turnId: string; resetAt: number | null; endedAt: number; skipped?: Exclude<ArmDecision, { arm: true }>['reason'] }
  >()
  /** A resume turn on its way: when it started, and whether it reported an error. */
  private readonly resumed = new Map<string, { startedAt: number; failed: boolean }>()
  private readonly firing = new Set<string>()

  constructor(
    private readonly host: LimitResumeHost,
    private readonly now: () => number = Date.now,
  ) {}

  /** Rebuild one timer per armed row. Rows left armed while the flag was off wait for it. */
  start(): void {
    if (!this.host.enabled()) return
    let rows: LimitResumeRow[]
    try {
      rows = listArmedLimitResumes()
    } catch (err) {
      log.warn('could not read armed auto-resumes', err)
      return
    }
    for (const row of rows) this.schedule(row.conversationId, row.requestId, row.resetAt + LIMIT_RESUME_FIRE_DELAY_MS)
    if (rows.length > 0) log.info(`${rows.length} auto-resume timer(s) rebuilt`)
  }

  enabled(): boolean {
    return this.host.enabled()
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /** A turn of a live session ended: arm on a usage limit, count a resumed turn's outcome. Never throws into the publish path. */
  onTurnEnded(threadId: string, limit: TurnLimit | undefined, turnId: string | undefined): void {
    try {
      this.turnEnded(threadId, limit, turnId)
    } catch (err) {
      log.warn(`auto-resume bookkeeping for ${threadId} failed`, err)
    }
  }

  private turnEnded(threadId: string, limit: TurnLimit | undefined, turnId: string | undefined): void {
    if (!this.host.enabled()) return
    const id = resolveRootThreadId(threadId)
    const usageLimit = limit?.limitClass === 'usage_limit'
    const resumed = this.resumed.get(id)
    this.resumed.delete(id)
    let row = getLimitResume(id)
    if (resumed && row) {
      const outcome = usageLimit ? 'limited' : resumed.failed ? 'failed' : 'ok'
      const streak = nextStreak({ streak: row.streak, startedAt: resumed.startedAt, endedAt: this.now(), outcome })
      setLimitResumeStreak(id, streak.streak, streak.gaveUp)
      log.info('limit resume outcome', { conversationId: id, outcome, streak: streak.streak, gaveUp: streak.gaveUp })
      if (streak.gaveUp) {
        this.limited.set(id, {
          turnId: turnId ?? `turn_${this.now()}`,
          resetAt: limit?.resetAt ?? null,
          endedAt: this.now(),
        })
        this.clearTimer(id)
        this.notify(id, false)
        return
      }
      row = getLimitResume(id)
    }

    if (!usageLimit) {
      const wasLimited = this.limited.delete(id)
      let cleared = false
      if (row?.state === 'armed') cleared = disarmLimitResume(id, 'ran')
      else if (row?.state === 'gave_up') {
        setLimitResumeStreak(id, 0, false)
        cleared = true
      }
      if (cleared) this.clearTimer(id)
      if (wasLimited || cleared) this.notify(id, false)
      return
    }

    // A Claude rejection followed by a late empty result ends one turn twice:
    // arm once, and never again after a Stop in between. Claude ends carry no
    // turn id, so the same reset moments later stands for the same turn.
    const resetAt = limit.resetAt
    const previous = this.limited.get(id)
    if (previous && previous.resetAt === resetAt && this.now() - previous.endedAt < SAME_LIMIT_MS) return
    const limitedTurnId = turnId ?? `turn_${this.now()}`
    const mark = { turnId: limitedTurnId, resetAt, endedAt: this.now() }
    const decision = shouldArm({
      limitClass: 'usage_limit',
      resetAt,
      turnId: limitedTurnId,
      turnEndedAt: this.now(),
      settingOn: this.host.settingOn(),
      row,
    })
    if (!decision.arm) {
      this.limited.set(id, { ...mark, skipped: decision.reason })
      log.info('limit resume not armed', { conversationId: id, reason: decision.reason })
      this.notify(id, false)
      return
    }
    const requestId = randomUUID()
    armLimitResume({
      conversationId: id,
      providerInstanceId: this.host.instanceOf(threadId) ?? '',
      limitedTurnId,
      resetAt: resetAt!,
      requestId,
    })
    // A new limit starts a new count; only resumes of one limit add up.
    if (!resumed) setLimitResumeStreak(id, 0, false)
    this.limited.set(id, mark)
    this.schedule(id, requestId, resetAt! + LIMIT_RESUME_FIRE_DELAY_MS)
    log.info('limit resume armed', { conversationId: id, resetAt })
    this.notify(id, false)
  }

  /** The adapter reported an error: a resume turn on its way counts as failed. */
  onError(threadId: string): void {
    const pending = this.resumed.get(resolveRootThreadId(threadId))
    if (pending) pending.failed = true
  }

  /** The chat's session started again: fire a resume that came due while it was not running. */
  onSessionStarted(threadId: string): void {
    if (!this.host.enabled()) return
    const id = resolveRootThreadId(threadId)
    const row = getLimitResume(id)
    if (row?.state === 'armed' && !this.timers.has(id))
      this.schedule(id, row.requestId, row.resetAt + LIMIT_RESUME_FIRE_DELAY_MS)
  }

  disarm(threadId: string, reason: LimitDisarmReason): void {
    const id = resolveRootThreadId(threadId)
    let disarmed: boolean
    try {
      disarmed = disarmLimitResume(id, reason)
    } catch (err) {
      log.warn(`could not disarm the auto-resume of ${id}`, err)
      return
    }
    if (!disarmed) return
    this.clearTimer(id)
    log.info('limit resume disarmed', { conversationId: id, reason })
    this.notify(id, false)
  }

  /** What the chat's Limited row shows. */
  view(threadId: string): LimitState {
    if (!this.host.enabled()) return { kind: 'none' }
    const id = resolveRootThreadId(threadId)
    const row = getLimitResume(id)
    const current = this.limited.get(id)
    // A restart forgets which chats are limited; an armed or given-up row still says so.
    if (!current) return row?.state === 'armed' || row?.state === 'gave_up' ? limitState(true, row) : { kind: 'none' }
    // Setting off: today's behaviour, the queue holds until you resume it.
    if (current.skipped === 'setting_off') return { kind: 'none' }
    const forThisLimit = row && (row.limitedTurnId === current.turnId || row.state === 'gave_up')
    return limitState(true, forThisLimit ? row : null)
  }

  /** Resume now: every fire check except the clock. A closed window keeps the row armed. */
  async resumeNow(threadId: string): Promise<ResumeNowResult> {
    if (!this.host.enabled()) return { ok: false, message: 'Auto-resume is off.' }
    const row = getLimitResume(resolveRootThreadId(threadId))
    if (row?.state !== 'armed') return { ok: false, message: 'No auto-resume is armed for this chat.' }
    return this.fire(row.conversationId, row.requestId, true)
  }

  private schedule(id: string, requestId: string, at: number): void {
    this.clearTimer(id)
    const timer = setTimeout(
      () => {
        this.timers.delete(id)
        this.fire(id, requestId, false).catch((err) => log.warn(`auto-resume of ${id} failed`, err))
      },
      Math.min(Math.max(0, at - this.now()), MAX_TIMER_MS),
    )
    timer.unref?.()
    this.timers.set(id, timer)
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
  }

  private notify(id: string, resumed: boolean): void {
    this.host.changed(id, this.view(id), resumed)
  }

  private async fire(id: string, requestId: string, manual: boolean): Promise<ResumeNowResult> {
    if (this.firing.has(id)) return { ok: false, message: 'A resume is already on its way.' }
    this.firing.add(id)
    const span = perfSpan('limit-resume.fire', { conversationId: id, manual })
    let outcome = 'error'
    try {
      const result = await this.fireOnce(id, requestId, manual)
      outcome = result.outcome
      return result.reply
    } finally {
      this.firing.delete(id)
      span.end({ outcome })
    }
  }

  private async fireOnce(
    id: string,
    requestId: string,
    manual: boolean,
  ): Promise<{ outcome: string; reply: ResumeNowResult }> {
    const refuse = (outcome: string, message: string) => ({ outcome, reply: { ok: false as const, message } })
    if (!this.host.enabled()) return refuse('flag_off', 'Auto-resume is off.')
    if (!manual && !this.host.settingOn()) {
      this.disarm(id, 'cancel')
      return refuse('setting_off', 'Auto-resume is off.')
    }
    const live = this.host.liveThread(id)
    // ponytail: a chat whose session is not running waits until it starts
    // again (onSessionStarted); restarting the session here is restart recovery's job.
    if (!live) return refuse('not_running', 'The chat is not running. Send a message to continue.')
    // A turn already runs (you sent one): its end decides, disarming or arming again.
    if (this.host.busy(live)) {
      if (!manual) this.schedule(id, requestId, this.now() + RETRY_MS)
      return refuse('busy', 'The chat is running a turn.')
    }

    const checks = (probe: UsageProbe) =>
      fireChecks({
        row: getLimitResume(id),
        requestId,
        now: this.now(),
        manual,
        archived: this.host.archived(id),
        liveRequestForUser: this.host.needsYou(live),
        currentInstanceId: this.host.instanceOf(live) ?? '',
        probe,
        child: null,
      })
    // The cheap checks first: a reading can be a keychain read.
    let decision = checks({ open: true })
    if (decision.action === 'fire') {
      const row = getLimitResume(id)!
      decision = checks(usageProbe(await this.host.usage(row.providerInstanceId), this.now()))
    }

    switch (decision.action) {
      case 'drop': {
        const reason: Record<typeof decision.reason, LimitDisarmReason | null> = {
          stale: null,
          archived: 'archive',
          settled: 'settle',
          parent_held: 'parent_stop',
          instance_changed: 'moved',
          no_reset: 'no_reset',
        }
        const disarmReason = reason[decision.reason]
        if (disarmReason) this.disarm(id, disarmReason)
        return refuse(decision.reason, 'This auto-resume is no longer armed.')
      }
      case 'wait':
        if (decision.reason === 'early')
          this.schedule(id, requestId, getLimitResume(id)!.resetAt + LIMIT_RESUME_FIRE_DELAY_MS)
        else if (!manual) this.schedule(id, requestId, this.now() + RETRY_MS)
        return refuse(
          decision.reason,
          decision.reason === 'needs_you'
            ? 'Answer the open card first.'
            : decision.reason === 'closed'
              ? 'The usage window is still closed.'
              : 'Not yet.',
        )
      case 'rearm': {
        const row = getLimitResume(id)!
        const streak = nextStreak({
          streak: row.streak,
          startedAt: this.now(),
          endedAt: this.now(),
          outcome: 'limited',
        })
        if (streak.gaveUp) {
          setLimitResumeStreak(id, streak.streak, true)
          log.info('limit resume outcome', {
            conversationId: id,
            outcome: 'still_closed',
            streak: streak.streak,
            gaveUp: true,
          })
        } else {
          const next = randomUUID()
          armLimitResume({ ...row, resetAt: decision.resetAt, requestId: next })
          setLimitResumeStreak(id, streak.streak, false)
          this.schedule(id, next, decision.resetAt + LIMIT_RESUME_FIRE_DELAY_MS)
        }
        this.notify(id, false)
        return refuse('rearm', 'The usage window is still closed.')
      }
      case 'fire':
        break
    }

    if (!markLimitResumeFired(id, requestId, this.now())) return refuse('stale', 'This auto-resume is no longer armed.')
    this.resumed.set(id, { startedAt: this.now(), failed: false })
    if (!(await this.host.sendResume(live))) {
      this.resumed.delete(id)
      const row = getLimitResume(id)!
      const next = randomUUID()
      armLimitResume({ ...row, requestId: next })
      this.schedule(id, next, this.now() + RETRY_MS)
      return refuse('send_failed', 'The resume could not be sent. It tries again in 5 minutes.')
    }
    this.limited.delete(id)
    this.notify(id, true)
    return { outcome: 'fired', reply: { ok: true } }
  }
}
