/**
 * Stop controls for bridge work on this desktop: the durable stop generation
 * and kill, the relay's `control` frames, the owner's Stop all, the control
 * lease for work the relay started, and what runs at start and on wake.
 *
 * Every change is written to SQLite before any chat is stopped, so a crash
 * mid-stop still finds the kill and the generation at the next start. The
 * generation never goes down. A kill is never cleared here on its own: the
 * relay clears it (the operator's `clear-kill`), or, on a desktop that is not
 * enrolled, the owner's "Allow bridge work again". A stop that cannot show
 * that a chat has no turn left reports `unconfirmed`, never stopped.
 *
 * This works with the `instinct_bridge` flag off too: a saved kill, the
 * generation, status and stops stay in force for existing bridge origins.
 * A stop also kills a measured check this desktop was running, and
 * start-time recovery cancels one the previous process left behind, so none
 * can report a result it never had.
 */
import {
  BRIDGE_CONTROL_LEASE_MS,
  type BridgeControl,
  type BridgeStopResult,
  type BridgeStopStatus,
} from '@shared/bridge'
import {
  cancelInterruptedBridgeCheckRuns,
  markPendingBridgeStopsUnconfirmed,
  readBridgeStopRecord,
  recoverBridgeCalls,
  retireExpiredBridgeCalls,
  writeBridgeStopRecord,
  type BridgeOriginSource,
} from '../db/database'
import { createMainLogger } from '../logger'
import { bridgeCheckService } from './check-service'

const log = createMainLogger('bridge:stop')

export const BRIDGE_CLEAR_KILL_COMMAND = 'node scripts/bridge-operator.mjs clear-kill'
const LEASE_TICK_MS = 10_000
const RETIRE_EVERY_MS = 24 * 60 * 60 * 1000

export interface BridgeStopHost {
  /** Root ids of the active bridge groups, all or only those of `sources`. */
  activeGroups(sources?: readonly BridgeOriginSource[]): string[]
  /** Stops them as stop_chat does (bridge-queued messages back, then the user's Stop). */
  stopGroups(sources?: readonly BridgeOriginSource[]): Promise<{ stopped: string[]; unconfirmed: string[] }>
  relay: {
    enrolled(): boolean
    lastContactAt(): number | null
    sendStopAck(generation: number, state: 'confirmed' | 'unconfirmed'): boolean
    sendKill(generation: number): boolean
  }
  chatTitle(chatId: string): string | null
  now(): number
}

export class BridgeStopService {
  /** One stop at a time: a control, a Stop all and a lease check never interleave. */
  private queue: Promise<unknown> = Promise.resolve()
  private timers: Array<ReturnType<typeof setInterval>> = []

  constructor(
    private readonly host: BridgeStopHost,
    private readonly leaseMs = BRIDGE_CONTROL_LEASE_MS,
  ) {}

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run)
    this.queue = next.catch((err: unknown) => log.warn('bridge stop step failed', { err: String(err) }))
    return next
  }

  /**
   * At app start, before any registry or queued turn: settle calls a crash
   * left mid-way, retire expired ones, and turn a stop that was still pending
   * into an unconfirmed result (no process from before can be accounted for).
   */
  enforceAtStart(): void {
    const recovered = recoverBridgeCalls()
    const retired = retireExpiredBridgeCalls(this.host.now())
    const pending = markPendingBridgeStopsUnconfirmed()
    // A check the previous process was running cannot be accounted for either.
    const checks = cancelInterruptedBridgeCheckRuns(this.host.now())
    const record = readBridgeStopRecord()
    const covered = record.lastResult?.generation ?? 0
    if (record.generation > covered || pending.length > 0) {
      writeBridgeStopRecord({
        ...record,
        lastResult: {
          generation: record.generation,
          state: 'unconfirmed',
          unconfirmed: pending,
          stopped: 0,
          at: this.host.now(),
        },
      })
    }
    log.info('bridge stop state at start', {
      generation: record.generation,
      killed: record.killed,
      pending: pending.length,
      ...recovered,
      retired,
      checksCancelled: checks,
    })
  }

  /** The lease check every 10 s and the daily retire of expired call records. */
  start(): void {
    if (this.timers.length > 0) return
    const lease = setInterval(() => void this.checkLease(), LEASE_TICK_MS)
    const retire = setInterval(() => {
      try {
        retireExpiredBridgeCalls(this.host.now())
      } catch (err) {
        log.warn('retiring expired bridge calls failed', err)
      }
    }, RETIRE_EVERY_MS)
    lease.unref?.()
    retire.unref?.()
    this.timers = [lease, retire]
  }

  dispose(): void {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
  }

  /**
   * The relay's stop state (welcome or `control`). Recorded first. A stop the
   * relay ordered (generation above 0) that this desktop has no result for
   * stops every active group; the relay then gets a `stop_ack` for its
   * generation. Generation 0 means no stop was ever ordered, so a fresh
   * desktop's first welcome leaves running work alone. A kill made here that
   * the relay has not seen yet is kept and sent again.
   */
  applyControl(control: BridgeControl): Promise<void> {
    return this.serial(async () => {
      const before = readBridgeStopRecord()
      const relayCurrent = control.stop_generation >= before.generation
      const killPending = before.killPending && !(relayCurrent && control.killed)
      const killed = killPending || (relayCurrent ? control.killed : before.killed)
      const record = writeBridgeStopRecord({ generation: control.stop_generation, killed, killPending })
      if (before.killed && !killed) log.info('bridge kill cleared by the relay', { generation: record.generation })
      if (killPending) this.host.relay.sendKill(record.generation)
      if (control.stop_generation === 0) return
      const known = record.lastResult
      const result =
        known && known.generation >= control.stop_generation ? known : await this.runStop(record.generation)
      this.host.relay.sendStopAck(control.stop_generation, result.state)
    })
  }

  /**
   * A generation a relay `command` frame named that is above ours: a
   * `control` was missed, so the generation is recorded and that stop runs
   * before the command does. A command frame says nothing about the kill, so
   * the stored one is read here, inside the queue, and left as it stands; a
   * kill queued behind this step is never overwritten by a stale snapshot.
   * A generation that is not above ours records nothing and stops nothing,
   * but a command that adds work calls this anyway, so it waits here for a
   * stop already running before it dispatches.
   */
  advanceStopGeneration(generation: number): Promise<void> {
    return this.serial(async () => {
      const before = readBridgeStopRecord()
      if (generation <= before.generation) return
      const record = writeBridgeStopRecord({ generation, killed: before.killed, killPending: before.killPending })
      const known = record.lastResult
      const result = known && known.generation >= generation ? known : await this.runStop(record.generation)
      this.host.relay.sendStopAck(generation, result.state)
    })
  }

  /** The owner's Stop all on this desktop: a new generation and a kill, sent to the relay when connected. */
  stopAll(): Promise<BridgeStopStatus> {
    return this.serial(async () => {
      const before = readBridgeStopRecord()
      const record = writeBridgeStopRecord({ generation: before.generation + 1, killed: true, killPending: true })
      log.info('stop of all bridge work', { generation: record.generation })
      // Not connected: the next welcome finds the kill still pending and sends it.
      this.host.relay.sendKill(record.generation)
      await this.runStop(record.generation)
      return this.status()
    })
  }

  /** Only on a desktop that is not enrolled; an enrolled one follows the relay. */
  clearLocalKill(): BridgeStopStatus {
    if (this.host.relay.enrolled())
      throw new Error(`This Mac is enrolled, so the kill follows the relay. Run: ${BRIDGE_CLEAR_KILL_COMMAND}`)
    const record = readBridgeStopRecord()
    writeBridgeStopRecord({ generation: record.generation, killed: false, killPending: false })
    log.info('bridge kill cleared on this desktop', { generation: record.generation })
    return this.status()
  }

  /** Work the relay started stops once the relay has been silent for the lease. */
  checkLease(): Promise<void> {
    const last = this.host.relay.lastContactAt()
    const expired = last === null || this.host.now() - last > this.leaseMs
    if (!expired || this.host.activeGroups(['relay']).length === 0) return Promise.resolve()
    return this.serial(async () => {
      log.info('bridge control lease expired', { lastContactAt: last })
      await this.host.stopGroups(['relay'])
    })
  }

  /** The relay revoked this device, or the owner removed the enrollment: stop the work the relay started. */
  authorityLost(reason: 'revoked' | 'unenrolled'): Promise<void> {
    if (this.host.activeGroups(['relay']).length === 0) return Promise.resolve()
    return this.serial(async () => {
      log.info('bridge relay authority lost', { reason })
      await this.host.stopGroups(['relay'])
    })
  }

  /** After sleep: the saved kill first, then the lease. */
  async onWake(): Promise<void> {
    if (readBridgeStopRecord().killed && this.host.activeGroups().length > 0)
      await this.serial(async () => {
        await this.runStop(readBridgeStopRecord().generation)
      })
    await this.checkLease()
  }

  killed(): boolean {
    return readBridgeStopRecord().killed
  }

  status(): BridgeStopStatus {
    const record = readBridgeStopRecord()
    const enrolled = this.host.relay.enrolled()
    const last = this.host.relay.lastContactAt()
    const result = record.lastResult
    return {
      killed: record.killed,
      stop_generation: record.generation,
      kill_pending: record.killPending,
      enrolled,
      last_result: result
        ? { ...result, unconfirmed_titles: result.unconfirmed.map((id) => this.host.chatTitle(id) ?? id) }
        : null,
      active_chats: this.host.activeGroups().length,
      last_contact_at: last,
      lease_expires_at: last === null ? null : last + this.leaseMs,
      clear_command: record.killed && enrolled ? BRIDGE_CLEAR_KILL_COMMAND : null,
    }
  }

  private async runStop(generation: number): Promise<BridgeStopResult> {
    // A measured check this desktop started is bridge work too: kill it first,
    // recorded as cancelled, and the gate in the check service starts no more.
    bridgeCheckService()?.cancelAll()
    const { stopped, unconfirmed } = await this.host.stopGroups()
    const result: BridgeStopResult = {
      generation,
      state: unconfirmed.length > 0 ? 'unconfirmed' : 'confirmed',
      unconfirmed,
      stopped: stopped.length,
      at: this.host.now(),
    }
    const current = readBridgeStopRecord()
    writeBridgeStopRecord({ ...current, lastResult: result })
    log.info('bridge stop result', { generation, state: result.state, stopped: stopped.length })
    return result
  }
}

let service: BridgeStopService | null = null

export function setBridgeStopService(next: BridgeStopService | null): void {
  service = next
}

/** Null on a backend that runs no stop controls (the headless server). */
export function bridgeStopService(): BridgeStopService | null {
  return service
}
