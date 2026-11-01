/**
 * The desktop's side of a child machine's outbox (flag `hub_remote_children`):
 * pull, import, ack.
 *
 * A pull runs on that machine's `hub-remote:outbox` event, on its connect,
 * when its client is ready again after a reconnect or missed events it could
 * not replay (`RemoteHubClients.onResync`), and at launch for machines already
 * connected. One pull runs at a time per machine; a request during one runs
 * one more after it. Each pull reads pages of `pageSize` items until a short
 * page, and only from a backend that advertises `hub_remote_outbox_v1`.
 *
 * Each item is imported once per (machine, item id) (`hub_remote_imports`),
 * and acked only after its import committed, so a lost ack re-pulls it and the
 * import skips it. An item is trusted only for the machine it came from: its
 * child must be a desktop row with that `machine_id` and that parent, or it
 * is recorded as dropped. A wake becomes a desktop wake through the wake
 * scheduler (`recordWake`), with the machine id and no transcript path; a
 * failed or stopped wake written at a failed start there ends the row here
 * `failed_start`, as a local one would. A message goes to the parent along the
 * lineage edge, which charges that edge's budget here (`deliverMessage`); a
 * parent that is not running is tried again on a timer, at most
 * `MESSAGE_ATTEMPTS` times, then recorded as refused, like a refusal of the
 * budget. Messages past the per-pair rate (a backlog after the machine was
 * away) wait for the next retry pull without using up those tries.
 *
 * Measured: one `hub.outbox-pull` perf line per pull (machine, pages, items,
 * the oldest item's age, items left for a retry, outcome).
 */
import { HubRemoteChannels } from '@shared/ipc-channels'
import {
  HUB_OUTBOX_PULL_DEFAULT,
  isHubOutboxId,
  parseHubOutboxItem,
  type HubOutboxItem,
  type HubOutboxMessage,
} from '@shared/hub-remote'
import type { HubPointer, HubWakeKind } from '@shared/hub'
import {
  getHubChild,
  getHubRemoteImport,
  insertHubRemoteImport,
  pruneHubRemoteImports,
  resolveRootThreadId,
  setHubRemoteImportOutcome,
  type HubChildRow,
} from '../db/database'
import { createMainLogger } from '../logger'
import { perfSpan } from '../perf'

const log = createMainLogger('hub:remote-outbox')

/** Tries for a message whose parent is not running, one per retry pull. */
export const MESSAGE_ATTEMPTS = 5
export const OUTBOX_RETRY_MS = 60_000
/** Import records older than this are deleted at launch; the child machine deleted those items long before. */
const IMPORTS_KEEP_MS = 30 * 24 * 60 * 60_000

export interface HubRemoteOutboxHost {
  /** `hub_remote_children` on this desktop, read on every pull. */
  enabled(): boolean
  /** This desktop's `hub.installId`. */
  installId(): string
  supportsOutbox(machineId: string): Promise<boolean>
  invoke(machineId: string, channel: string, ...args: unknown[]): Promise<unknown>
  /** Stores a wake through the wake scheduler; `inTransaction` runs in the insert's transaction. */
  recordWake(
    w: {
      parentId: string
      childId: string
      kind: HubWakeKind
      summary: string
      pointer: HubPointer
      machineId: string
    },
    inTransaction: () => void,
  ): void
  /** `HubStarter.remoteChildFailedStart`: inside the transaction; what to run after it committed. */
  failedStart(childId: string): (() => void) | null
  /** The parent chat's session runs and is not switching profiles, so a message can be delivered now. */
  parentRunning(parentId: string): boolean
  /** The child's per-pair rate toward its parent has room for one more message now. */
  rateHasRoom(child: HubChildRow): boolean
  /** Delivers the message to the parent along the lineage edge, charging it; resolves to a refusal's text. */
  deliverMessage(m: { child: HubChildRow } & HubOutboxMessage): Promise<{ ok: true } | { ok: false; reason: string }>
}

type ImportResult = 'done' | 'retry'

interface MachinePull {
  running: Promise<void>
  again: boolean
}

export class HubRemoteOutbox {
  private readonly pulls = new Map<string, MachinePull>()
  private readonly attempts = new Map<string, number>()
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Machines already logged as too old to pull from, until their next connect. */
  private readonly loggedOld = new Set<string>()
  private readonly pageSize: number
  private readonly retryMs: number
  private disposed = false

  constructor(
    private readonly host: HubRemoteOutboxHost,
    opts: { pageSize?: number; retryMs?: number } = {},
  ) {
    this.pageSize = opts.pageSize ?? HUB_OUTBOX_PULL_DEFAULT
    this.retryMs = opts.retryMs ?? OUTBOX_RETRY_MS
  }

  /** Deletes old import records. */
  start(): void {
    try {
      pruneHubRemoteImports(IMPORTS_KEEP_MS)
    } catch (err) {
      log.warn('could not prune old outbox import records', err)
    }
  }

  /** A machine connected: it is logged again if it is still too old. */
  connected(machineId: string): Promise<void> {
    this.loggedOld.delete(machineId)
    return this.pull(machineId)
  }

  /** Pulls the machine's outbox, or runs one more pull after the one running now. */
  pull(machineId: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const current = this.pulls.get(machineId)
    if (current) {
      current.again = true
      return current.running
    }
    const entry: MachinePull = { running: Promise.resolve(), again: false }
    entry.running = (async () => {
      try {
        do {
          entry.again = false
          await this.pullOnce(machineId)
        } while (entry.again && !this.disposed)
      } finally {
        this.pulls.delete(machineId)
      }
    })()
    this.pulls.set(machineId, entry)
    return entry.running
  }

  dispose(): void {
    this.disposed = true
    for (const t of this.retryTimers.values()) clearTimeout(t)
    this.retryTimers.clear()
  }

  private async pullOnce(machineId: string): Promise<void> {
    if (!this.host.enabled()) return
    if (!(await this.host.supportsOutbox(machineId))) {
      if (!this.loggedOld.has(machineId)) {
        this.loggedOld.add(machineId)
        log.info('machine has no outbox; its children reports stay there until its backend is updated', {
          machineId,
        })
      }
      return
    }
    const span = perfSpan('hub.outbox-pull', { machineId })
    const installId = this.host.installId()
    let pages = 0
    let items = 0
    let retries = 0
    let oldest: number | null = null
    try {
      let after: string | undefined
      for (;;) {
        const answer = (await this.host.invoke(machineId, HubRemoteChannels.OUTBOX_PULL, {
          v: 1,
          desktopInstallId: installId,
          ...(after ? { after } : {}),
          limit: this.pageSize,
        })) as { items?: unknown } | null
        if (!answer || !Array.isArray(answer.items)) throw new Error('the outbox answer has no item list')
        const raw = answer.items.slice(0, this.pageSize)
        pages++
        items += raw.length
        const acks: string[] = []
        for (const value of raw) {
          const item = parseHubOutboxItem(value)
          if (!item) {
            const id = this.malformedId(machineId, value)
            if (id) acks.push(id)
            continue
          }
          oldest = oldest === null ? item.createdAt : Math.min(oldest, item.createdAt)
          const result = await this.importItem(machineId, item)
          if (result === 'retry') retries++
          else acks.push(item.id)
          if (this.disposed) return
        }
        if (acks.length > 0)
          await this.host.invoke(machineId, HubRemoteChannels.OUTBOX_ACK, {
            v: 1,
            desktopInstallId: installId,
            ids: acks,
          })
        if (raw.length < this.pageSize) break
        const last = (raw.at(-1) as { id?: unknown } | null)?.id
        if (!isHubOutboxId(last) || last === after) break
        after = last
      }
      span.end({
        outcome: 'ok',
        pages,
        items,
        retries,
        ...(oldest !== null ? { oldestAgeMs: Math.max(0, Date.now() - oldest) } : {}),
      })
    } catch (err) {
      span.end({ outcome: 'error', pages, items })
      log.warn(`could not pull the outbox of machine ${machineId}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (retries > 0) this.retryLater(machineId)
  }

  /** An item that does not parse is recorded and acked when it has an id; otherwise it is only logged. */
  private malformedId(machineId: string, value: unknown): string | null {
    const id = (value as { id?: unknown } | null)?.id
    log.warn('dropped a malformed outbox item', { machineId, id: isHubOutboxId(id) ? id : null })
    if (!isHubOutboxId(id)) return null
    try {
      insertHubRemoteImport({
        machineId,
        remoteId: id,
        kind: null,
        childId: null,
        outcome: 'dropped',
        reason: 'malformed',
      })
    } catch (err) {
      log.warn('could not record a malformed outbox item; it is pulled again', err)
      return null
    }
    return id
  }

  private retryLater(machineId: string): void {
    if (this.disposed || this.retryTimers.has(machineId)) return
    const timer = setTimeout(() => {
      this.retryTimers.delete(machineId)
      void this.pull(machineId)
    }, this.retryMs)
    timer.unref?.()
    this.retryTimers.set(machineId, timer)
  }

  /** Why the item may not act on the desktop, or null. Its child must be this machine's and its parent's. */
  private trustProblem(machineId: string, item: HubOutboxItem, child: HubChildRow | null): string | null {
    if (!child) return 'unknown child'
    if (child.machineId === null) return 'a local child'
    if (child.machineId !== machineId) return 'a child of another machine'
    if (child.parentId !== resolveRootThreadId(item.parentId)) return 'another parent'
    if (child.phase === 'settled') return 'a settled child'
    return null
  }

  private async importItem(machineId: string, item: HubOutboxItem): Promise<ImportResult> {
    try {
      if (getHubRemoteImport(machineId, item.id)) return 'done'
      const child = getHubChild(item.childId)
      const problem = this.trustProblem(machineId, item, child)
      if (problem || !child) {
        log.warn('dropped an outbox item', { machineId, id: item.id, kind: item.kind, reason: problem })
        insertHubRemoteImport({
          machineId,
          remoteId: item.id,
          kind: item.kind,
          childId: null,
          outcome: 'dropped',
          reason: problem,
        })
        return 'done'
      }
      return item.kind === 'wake'
        ? this.importWake(machineId, item, child)
        : await this.importMessage(machineId, item, child)
    } catch (err) {
      // Not recorded: the item stays unacked and the next pull tries it again.
      log.warn(`could not import outbox item ${item.id} of machine ${machineId}`, err)
      return 'retry'
    }
  }

  private importWake(
    machineId: string,
    item: Extract<HubOutboxItem, { kind: 'wake' }>,
    child: HubChildRow,
  ): ImportResult {
    const { wake } = item
    const afterCommit: Array<() => void> = []
    this.host.recordWake(
      {
        parentId: child.parentId,
        childId: child.childId,
        kind: wake.kind,
        summary: wake.summary,
        pointer: {
          childId: child.childId,
          at: wake.pointer?.at ?? item.createdAt,
          ...(wake.pointer?.toolCallId ? { toolCallId: wake.pointer.toolCallId } : {}),
        },
        machineId,
      },
      () => {
        insertHubRemoteImport({
          machineId,
          remoteId: item.id,
          kind: 'wake',
          childId: child.childId,
          outcome: 'imported',
        })
        if ((wake.kind === 'failed' || wake.kind === 'stopped') && wake.childPhase === 'failed_start') {
          const then = this.host.failedStart(child.childId)
          if (then) afterCommit.push(then)
        }
      },
    )
    for (const fn of afterCommit) fn()
    log.info('imported a wake from another machine', { machineId, childId: child.childId, kind: wake.kind })
    return 'done'
  }

  private async importMessage(
    machineId: string,
    item: Extract<HubOutboxItem, { kind: 'message' }>,
    child: HubChildRow,
  ): Promise<ImportResult> {
    const key = `${machineId}\u0000${item.id}`
    const refuse = (reason: string): ImportResult => {
      this.attempts.delete(key)
      log.warn('a message from a child on another machine was not delivered', {
        machineId,
        childId: child.childId,
        reason,
      })
      insertHubRemoteImport({
        machineId,
        remoteId: item.id,
        kind: 'message',
        childId: child.childId,
        outcome: 'refused',
        reason,
      })
      return 'done'
    }
    if (child.phase !== 'starting' && child.phase !== 'open') return refuse('the child is not open')
    if (!this.host.parentRunning(child.parentId)) {
      const tries = (this.attempts.get(key) ?? 0) + 1
      if (tries >= MESSAGE_ATTEMPTS) return refuse('the parent chat was not running')
      this.attempts.set(key, tries)
      return 'retry'
    }
    this.attempts.delete(key)
    // A backlog past the rate waits uncounted: each retry pull, a minute on, delivers more of it.
    if (!this.host.rateHasRoom(child)) return 'retry'
    // Claimed before the delivery: a crash during it delivers it at most once.
    if (
      !insertHubRemoteImport({
        machineId,
        remoteId: item.id,
        kind: 'message',
        childId: child.childId,
        outcome: 'delivering',
      })
    )
      return 'done'
    const result = await this.host.deliverMessage({ child, ...item.message })
    if (result.ok) {
      setHubRemoteImportOutcome(machineId, item.id, 'imported', null)
      log.info('delivered a message from a child on another machine', { machineId, childId: child.childId })
    } else {
      setHubRemoteImportOutcome(machineId, item.id, 'refused', result.reason)
      log.warn('a message from a child on another machine was refused', {
        machineId,
        childId: child.childId,
        reason: result.reason,
      })
    }
    return 'done'
  }
}
