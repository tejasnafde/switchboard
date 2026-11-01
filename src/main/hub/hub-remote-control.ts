/**
 * The desktop's side of a child on another machine after its start: view,
 * read, deliver, interrupt, stop, settle, move and stop-all, each a
 * `hub-remote:*` call through `RemoteHubClients` on the child's `machine_id`.
 * Nothing is sent with `hub_remote_children` off.
 *
 * A machine whose last `ready` lacked `hub_remote_control_v1` keeps the PR 5
 * texts for its children (`available` false); one not seen this run counts as
 * able, so a Stop for it waits.
 *
 * **Views.** One cache per machine and parent stub, read on
 * `hub-remote:children-changed`, on connect, and from a list call or a hub
 * view older than 15 s. A machine that is not connected keeps its last view,
 * shown with its age and "not connected".
 *
 * **Pending stops.** A Stop, a settle or a stop-all for a machine that is not
 * connected (or that did not answer in time) is a `hub_remote_pending` row,
 * sent on that machine's next connect before anything else, one machine at a
 * time; until its answer the child shows "Stopping on <machine>". A row is
 * deleted on an answer (`not_found` counts: nothing is left to stop) and kept
 * when the call fails again. Rows of a machine whose backend lacks the
 * capability are dropped with a log line, since it can never take them.
 */
import { HubRemoteChannels } from '@shared/ipc-channels'
import { HUB_REMOTE_STOP_LATER_TEXT, isHubOutboxId, isNoHandlerError } from '@shared/hub-remote'
import {
  HUB_REMOTE_VIEW_MAX_AGE_MS,
  parseHubRemoteOk,
  parseHubRemoteRefusal,
  parseHubRemoteSettleRow,
  parseHubRemoteToolAnswer,
  parseHubRemoteViewAnswer,
  type HubRemoteChildState,
} from '@shared/hub-remote-control'
import { isOpenChildPhase, type HubSettleRowView } from '@shared/hub'
import type { RuntimeMode } from '@shared/provider-events'
import type { TurnDelivery } from '@shared/turn-delivery'
import {
  addHubRemotePending,
  deleteHubRemotePending,
  listHubChildren,
  listHubRemotePending,
  listOpenRemoteHubChildren,
  updateHubChild,
  type HubChildRow,
  type HubRemotePendingRow,
} from '../db/database'
import { toolText, type McpToolResult } from '../mcp/mcp-session'
import { createMainLogger } from '../logger'
import { perfSpan } from '../perf'
import { HubRemoteCallError, type HubControlSupport } from './remote-hub-clients'

const log = createMainLogger('hub:remote-control')

export interface HubRemoteControlHost {
  /** `hub_remote_children`, read on every use. */
  enabled(): boolean
  installId(): string
  machineState(machineId: string): 'connected' | 'offline' | 'gone'
  machineName(machineId: string): string
  /** What the machine's last ready said about `hub_remote_control_v1`. */
  control(machineId: string): HubControlSupport
  /** Opens the client when needed; false when not connected or without the capability. */
  supportsControl(machineId: string): Promise<boolean>
  invoke(machineId: string, channel: string, ...args: unknown[]): Promise<unknown>
  /** Clients read the parent's view again; `rows`: the sidebar rows too (a child settled). */
  changed(parentId: string, rows?: boolean): void
  now?(): number
}

/** What a hub view and `list_children` add to a remote child. */
export interface HubRemoteChildFacts {
  machineId: string
  machine: string
  connected: boolean
  /** The cached state, or null before the first view answer. */
  state: HubRemoteChildState | null
  /** How old that state is, or null with none. */
  ageMs: number | null
  /** A Stop, settle or stop-all waits to be sent or answered. */
  stopping: boolean
}

interface ParentView {
  at: number
  children: Map<string, HubRemoteChildState>
}

/** A view read that failed is not tried again from a list call for this long. */
const VIEW_RETRY_MS = 15_000

export class HubRemoteControl {
  private readonly views = new Map<string, Map<string, ParentView>>()
  private readonly reading = new Map<string, Promise<void>>()
  private readonly failedAt = new Map<string, number>()
  private readonly flushing = new Map<string, Promise<void>>()
  private readonly now: () => number

  constructor(private readonly host: HubRemoteControlHost) {
    this.now = host.now ?? Date.now
  }

  /** False when the child's machine runs a backend without the control channels: the old texts stay. */
  available(child: Pick<HubChildRow, 'machineId'>): boolean {
    return !!child.machineId && this.host.control(child.machineId) !== 'no'
  }

  machineName(child: Pick<HubChildRow, 'machineId'>): string {
    return child.machineId ? this.host.machineName(child.machineId) : 'this machine'
  }

  // ─── Views ────────────────────────────────────────────────────

  /** The facts of one remote child from the cache; a stale view is read again in the background. */
  factsOf(child: HubChildRow): HubRemoteChildFacts | null {
    const machineId = child.machineId
    if (!machineId) return null
    const view = this.views.get(machineId)?.get(child.parentId)
    const connected = this.host.machineState(machineId) === 'connected'
    if (connected && (!view || this.now() - view.at >= HUB_REMOTE_VIEW_MAX_AGE_MS))
      void this.refresh(machineId, child.parentId, HUB_REMOTE_VIEW_MAX_AGE_MS, true)
    const state = view?.children.get(child.childId) ?? null
    return {
      machineId,
      machine: this.host.machineName(machineId),
      connected,
      state,
      ageMs: view && state ? this.now() - view.at : null,
      stopping: this.isStopping(child),
    }
  }

  /** Reads the views of every machine with children of the parent that are older than 15 s. */
  async refreshParent(parentId: string): Promise<void> {
    const machines = new Set(listHubChildren(parentId).flatMap((c) => (c.machineId ? [c.machineId] : [])))
    await Promise.all([...machines].map((m) => this.refresh(m, parentId, HUB_REMOTE_VIEW_MAX_AGE_MS, false)))
  }

  /** `hub-remote:children-changed` from a machine: the parents named that have children there read again. */
  childrenChanged(machineId: string, parentIds: unknown): void {
    if (!Array.isArray(parentIds)) return
    for (const id of parentIds.slice(0, 64)) {
      if (!isHubOutboxId(id)) continue
      if (!listHubChildren(id).some((c) => c.machineId === machineId)) continue
      void this.refresh(machineId, id, 0, false)
    }
  }

  /** A machine connected: its pending stops first, then the views of every parent with children there. */
  async connected(machineId: string): Promise<void> {
    if (!this.host.enabled()) return
    await this.flush(machineId)
    const parents = new Set(listOpenRemoteHubChildren().flatMap((c) => (c.machineId === machineId ? [c.parentId] : [])))
    await Promise.all([...parents].map((p) => this.refresh(machineId, p, 0, false)))
  }

  /** The machine was deleted: its views go, and so do its pending stops, which nothing can send now. */
  removed(machineId: string): void {
    this.views.delete(machineId)
    const rows = listHubRemotePending(machineId)
    for (const r of rows) deleteHubRemotePending(machineId, r.kind, r.targetId)
    if (rows.length > 0) log.warn('dropped the pending stops of a removed machine', { machineId, rows: rows.length })
    for (const parentId of new Set(rows.map((r) => r.parentId))) this.host.changed(parentId)
  }

  private refresh(machineId: string, parentId: string, maxAgeMs: number, fromView: boolean): Promise<void> {
    const key = `${machineId}\u0000${parentId}`
    const view = this.views.get(machineId)?.get(parentId)
    if (maxAgeMs > 0 && view && this.now() - view.at < maxAgeMs) return Promise.resolve()
    // A hub view must not ask again at once after a failure: it is drawn on every change.
    if (fromView && this.now() - (this.failedAt.get(key) ?? -Infinity) < VIEW_RETRY_MS) return Promise.resolve()
    if (!this.host.enabled() || this.host.machineState(machineId) !== 'connected') return Promise.resolve()
    const running = this.reading.get(key)
    if (running) return running
    const read = (async () => {
      if (!(await this.host.supportsControl(machineId))) return
      const answer = parseHubRemoteViewAnswer(
        await this.host.invoke(machineId, HubRemoteChannels.VIEW, {
          v: 1,
          desktopInstallId: this.host.installId(),
          parentId,
        }),
      )
      if (!answer) throw new Error('a malformed view answer')
      let parents = this.views.get(machineId)
      if (!parents) {
        parents = new Map()
        this.views.set(machineId, parents)
      }
      // Only children this desktop started on that machine for that parent.
      const own = new Set(
        listHubChildren(parentId, { includeSettled: true })
          .filter((c) => c.machineId === machineId)
          .map((c) => c.childId),
      )
      parents.set(parentId, {
        at: this.now(),
        children: new Map(answer.children.filter((c) => own.has(c.childId)).map((c) => [c.childId, c])),
      })
      this.failedAt.delete(key)
      this.host.changed(parentId)
    })()
      .catch((err: unknown) => {
        this.failedAt.set(key, this.now())
        log.warn(`could not read the view of machine ${machineId}: ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => {
        if (this.reading.get(key) === read) this.reading.delete(key)
      })
    this.reading.set(key, read)
    return read
  }

  // ─── Stops ────────────────────────────────────────────────────

  /** A Stop, settle or stop-all waits for this child (or its parent on that machine). */
  isStopping(child: Pick<HubChildRow, 'childId' | 'parentId' | 'machineId'>): boolean {
    if (!child.machineId) return false
    try {
      return listHubRemotePending(child.machineId).some((p) =>
        p.kind === 'stop_all' ? p.targetId === child.parentId : p.targetId === child.childId,
      )
    } catch (err) {
      log.warn('could not read the pending stops', err)
      return false
    }
  }

  /** The user's Stop (strip, Stop button). `pending`: sent when the machine connects. */
  async stop(child: HubChildRow): Promise<{ pending: boolean; ran: boolean }> {
    const machineId = this.machineOf(child)
    const r = await this.send(machineId, {
      kind: 'stop',
      targetId: child.childId,
      parentId: child.parentId,
      payload: null,
    })
    if (r.pending) this.host.changed(child.parentId)
    return { pending: r.pending, ran: r.answer?.ran === true }
  }

  /**
   * Settles the child on its machine and then here: the desktop row takes the
   * row that machine answered. `pending` while the machine is not connected.
   */
  async settle(
    child: HubChildRow,
    parentHead: string | null,
  ): Promise<{ status: 'settled'; row: HubSettleRowView } | { status: 'pending' }> {
    const machineId = this.machineOf(child)
    const r = await this.send(machineId, {
      kind: 'settle',
      targetId: child.childId,
      parentId: child.parentId,
      payload: { parentHead },
    })
    if (r.pending) {
      this.host.changed(child.parentId)
      return { status: 'pending' }
    }
    return { status: 'settled', row: this.markSettled(child, r.answer) }
  }

  /** An archive of the parent: every child of it on that machine stops there. Idempotent. */
  async stopAll(machineId: string, parentId: string): Promise<{ pending: boolean }> {
    if (this.host.control(machineId) === 'no') throw new Error(HUB_REMOTE_STOP_LATER_TEXT)
    const r = await this.send(machineId, { kind: 'stop_all', targetId: parentId, parentId, payload: null })
    if (!r.pending) this.settleAllOf(machineId, parentId)
    else this.host.changed(parentId)
    return { pending: r.pending }
  }

  /**
   * Sends one stop now, or keeps it pending when the machine is not connected
   * or did not answer. Throws the machine's refusal, or the old text for a
   * machine without the capability.
   */
  private async send(
    machineId: string,
    p: Omit<HubRemotePendingRow, 'createdAt' | 'machineId'>,
  ): Promise<{ pending: true; answer?: undefined } | { pending: false; answer: Record<string, unknown> | null }> {
    if (!this.host.enabled()) throw new Error('hub_remote_children is off on this desktop')
    const keep = () => {
      addHubRemotePending({ ...p, machineId })
      log.info('remote stop kept until the machine connects', { machineId, kind: p.kind, targetId: p.targetId })
      return { pending: true as const }
    }
    if (this.host.machineState(machineId) !== 'connected') return keep()
    if (!(await this.host.supportsControl(machineId))) {
      if (this.host.control(machineId) === 'no') throw new Error(HUB_REMOTE_STOP_LATER_TEXT)
      return keep()
    }
    try {
      const answer = await this.call(machineId, p)
      deleteHubRemotePending(machineId, p.kind, p.targetId)
      return { pending: false, answer }
    } catch (err) {
      if (err instanceof HubRemoteCallError && (err.outcome === 'not_connected' || err.outcome === 'timeout'))
        return keep()
      throw err
    }
  }

  /** One stop call; resolves with the ok answer (null for a child the machine does not have), throws a refusal. */
  private async call(
    machineId: string,
    p: Pick<HubRemotePendingRow, 'kind' | 'targetId' | 'payload'>,
  ): Promise<Record<string, unknown> | null> {
    const installId = this.host.installId()
    let raw: unknown
    try {
      raw =
        p.kind === 'stop_all'
          ? await this.host.invoke(machineId, HubRemoteChannels.STOP_ALL, {
              v: 1,
              desktopInstallId: installId,
              parentId: p.targetId,
            })
          : await this.host.invoke(machineId, HubRemoteChannels.STOP, {
              v: 1,
              desktopInstallId: installId,
              childId: p.targetId,
              ...(p.kind === 'settle'
                ? { settle: { parentHead: typeof p.payload?.parentHead === 'string' ? p.payload.parentHead : null } }
                : {}),
            })
    } catch (err) {
      if (err instanceof Error && isNoHandlerError(err.message)) throw new Error(HUB_REMOTE_STOP_LATER_TEXT)
      throw err
    }
    const refusal = parseHubRemoteRefusal(raw)
    // Nothing of it is there (never started, or gone): the stop is done.
    if (refusal?.code === 'not_found') return null
    if (refusal) throw new Error(refusal.message)
    const ok = parseHubRemoteOk(raw)
    if (!ok) throw new Error(`${this.host.machineName(machineId)} answered the stop with a malformed answer`)
    return ok
  }

  /** Sends a machine's pending stops, oldest first; one flush at a time per machine. */
  flush(machineId: string): Promise<void> {
    const running = this.flushing.get(machineId)
    if (running) return running
    const run = this.flushNow(machineId).finally(() => {
      if (this.flushing.get(machineId) === run) this.flushing.delete(machineId)
    })
    this.flushing.set(machineId, run)
    return run
  }

  private async flushNow(machineId: string): Promise<void> {
    const rows = listHubRemotePending(machineId)
    if (rows.length === 0 || !this.host.enabled()) return
    const span = perfSpan('hub.remote-pending', { machineId, rows: rows.length })
    if (!(await this.host.supportsControl(machineId))) {
      if (this.host.control(machineId) === 'no') {
        for (const r of rows) deleteHubRemotePending(machineId, r.kind, r.targetId)
        log.warn('dropped pending stops: the machine runs a backend without hub_remote_control_v1', {
          machineId,
          rows: rows.length,
        })
        for (const parentId of new Set(rows.map((r) => r.parentId))) this.host.changed(parentId)
        span.end({ outcome: 'unsupported' })
      } else span.end({ outcome: 'not_ready' })
      return
    }
    let sent = 0
    for (const row of rows) {
      try {
        const answer = await this.call(machineId, row)
        deleteHubRemotePending(machineId, row.kind, row.targetId)
        sent++
        if (row.kind === 'stop_all') this.settleAllOf(machineId, row.parentId)
        else if (row.kind === 'settle') {
          const child = listHubChildren(row.parentId).find((c) => c.childId === row.targetId)
          if (child) this.markSettled(child, answer)
        }
        this.host.changed(row.parentId, row.kind !== 'stop')
      } catch (err) {
        if (err instanceof HubRemoteCallError) {
          // The connection went again: the rest waits for the next connect.
          log.warn(`pending stops of machine ${machineId} wait for its next connect: ${err.message}`)
          span.end({ outcome: 'interrupted', sent })
          return
        }
        // A refusal will not change on its own: dropped, and the child stays as it is.
        deleteHubRemotePending(machineId, row.kind, row.targetId)
        log.warn(`machine ${machineId} refused a pending ${row.kind}; it is dropped`, err)
        this.host.changed(row.parentId)
      }
    }
    span.end({ outcome: 'sent', sent })
  }

  /** The desktop row of a child its machine settled: settled here with that machine's row. */
  private markSettled(child: HubChildRow, answer: Record<string, unknown> | null): HubSettleRowView {
    const row = parseHubRemoteSettleRow(answer?.settled, child.childId, child.title) ?? {
      childId: child.childId,
      title: child.title,
      branch: child.branch,
      merged: null,
      clean: null,
      blockers: [],
      worktree: 'keep' as const,
      keepReason: `its worktree stays on ${this.machineName(child)}`,
    }
    updateHubChild(child.childId, {
      phase: 'settled',
      settledAt: this.now(),
      settleJson: JSON.stringify({
        worktree: row.worktree,
        keepReason: row.keepReason ?? null,
        machineId: child.machineId,
      }),
    })
    this.host.changed(child.parentId, true)
    return row
  }

  /** After a stop-all: the parent's rows on that machine are settled here; their worktrees stay there. */
  private settleAllOf(machineId: string, parentId: string): void {
    const name = this.host.machineName(machineId)
    for (const c of listHubChildren(parentId)) {
      if (c.machineId !== machineId || c.phase === 'settled') continue
      updateHubChild(c.childId, {
        phase: 'settled',
        settledAt: this.now(),
        settleJson: JSON.stringify({
          worktree: 'keep',
          keepReason: `stopped with its parent; its worktree stays on ${name}`,
          machineId,
        }),
      })
    }
    this.host.changed(parentId, true)
  }

  // ─── Calls that need the machine now ─────────────────────────

  /** `interrupt_child`: true when a turn ran. */
  async interrupt(child: HubChildRow): Promise<boolean> {
    const raw = await this.callNow(child, HubRemoteChannels.INTERRUPT, { childId: child.childId })
    return parseHubRemoteOk(raw)?.ran === true
  }

  /** A parent's message (lineage, Nudge), already charged here. Throws the machine's refusal. */
  async deliver(child: HubChildRow, text: string, delivery: TurnDelivery, fromLabel: string): Promise<void> {
    await this.callNow(child, HubRemoteChannels.DELIVER, {
      childId: child.childId,
      text,
      delivery,
      fromLabel: fromLabel.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200) || 'Parent chat',
    })
  }

  /** `read_child` on the child's machine. */
  async read(child: HubChildRow, args: Record<string, unknown>): Promise<McpToolResult> {
    const { childId: _id, ...rest } = args
    return this.toolCall(child, HubRemoteChannels.READ_CHILD, { childId: child.childId, args: rest })
  }

  /** `move_child` to an account on the child's machine. */
  async move(child: HubChildRow, instanceId: string, parentMode: RuntimeMode): Promise<McpToolResult> {
    return this.toolCall(child, HubRemoteChannels.MOVE, { childId: child.childId, instanceId, parentMode })
  }

  private async toolCall(child: HubChildRow, channel: string, body: Record<string, unknown>): Promise<McpToolResult> {
    const raw = await this.callNow(child, channel, body, true)
    const answer = parseHubRemoteToolAnswer(raw)
    if (!answer || !answer.ok) throw new Error(`${this.machineName(child)} answered with a malformed result`)
    return toolText(answer.text, answer.isError)
  }

  /** A call that needs the machine connected now; refusals throw their text. */
  private async callNow(
    child: HubChildRow,
    channel: string,
    body: Record<string, unknown>,
    toolAnswer = false,
  ): Promise<unknown> {
    const machineId = this.machineOf(child)
    if (!this.host.enabled()) throw new Error('hub_remote_children is off on this desktop')
    if (!isOpenChildPhase(child.phase) && channel !== HubRemoteChannels.READ_CHILD)
      throw new Error(`${child.title} is not open.`)
    if (this.host.machineState(machineId) !== 'connected')
      throw new Error(`${this.host.machineName(machineId)} is not connected`)
    if (!(await this.host.supportsControl(machineId)))
      throw new Error(
        this.host.control(machineId) === 'no'
          ? `Update the backend on ${this.host.machineName(machineId)} first.`
          : `${this.host.machineName(machineId)} is not connected`,
      )
    const raw = await this.host.invoke(machineId, channel, { v: 1, desktopInstallId: this.host.installId(), ...body })
    const refusal = parseHubRemoteRefusal(raw)
    if (refusal) {
      if (toolAnswer && refusal.code === 'failed') return { v: 1, ok: true, text: refusal.message, isError: true }
      throw new Error(refusal.message)
    }
    return raw
  }

  private machineOf(child: Pick<HubChildRow, 'machineId' | 'childId'>): string {
    if (!child.machineId) throw new Error(`${child.childId} runs on this machine`)
    return child.machineId
  }
}
