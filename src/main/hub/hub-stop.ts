/**
 * What keeps a child chat's state true between its reports, and what stops it.
 *
 * - `NativeSubagents`: the Agent/Task calls of each thread that still run. A
 *   child with one running shows Working, is never reaped, and its turn end is
 *   not "stopped without a report".
 * - `ChildTaskNotes`: whether a child told its parent anything since its last
 *   task (the brief, or a message from its parent). Switchboard writes at most
 *   one `stopped`, `failed` or `blocked` wake per task, and none after the
 *   child's own report.
 * - `HubIdleReaper`: a child whose last wake is a report, with no native
 *   subagent running, idle for `hub.idleReapMinutes`, has its session stopped
 *   and then every process left of its agent's tree killed. It resumes on its
 *   parent's next message. A parent is never reaped.
 *
 * Measured: one `hub.reap` perf line per reap (idle minutes, processes in the
 * tree, processes killed, outcome), threshold 0.
 */
import { isSubagentToolName, isAsyncAgentLaunch } from '@shared/subagent-steps'
import type { HubWakeKind } from '@shared/hub'
import type { RuntimeEvent } from '@shared/provider-events'
import { createMainLogger } from '../logger'
import { perfSpan } from '../perf'
import { defaultPs, parsePs, processTree } from './hub-measure'

const log = createMainLogger('hub:stop')

export interface SubagentCounts {
  running: number
  done: number
  failed: number
}

export class NativeSubagents {
  private readonly running = new Map<string, Set<string>>()
  private readonly ended = new Map<string, { done: number; failed: number }>()

  observe(event: RuntimeEvent): void {
    switch (event.type) {
      case 'tool.started': {
        // A subagent's own Agent call runs inside its topmost one.
        if (event.parentToolCallId || !isSubagentToolName(event.toolName)) return
        const set = this.running.get(event.threadId)
        if (set) set.add(event.toolId)
        else this.running.set(event.threadId, new Set([event.toolId]))
        return
      }
      case 'tool.completed':
        if (!this.running.get(event.threadId)?.has(event.toolId)) return
        // A background agent runs on until its notice.
        if (!event.isError && event.output !== undefined && isAsyncAgentLaunch(event.output)) return
        this.end(event.threadId, event.toolId, !event.isError)
        return
      case 'task.notification':
        if (event.toolUseId) this.end(event.threadId, event.toolUseId, event.status === 'completed')
        return
      case 'status':
        // The process is gone, and its subagents with it.
        if (event.status === 'stopped' || event.status === 'error') this.running.delete(event.threadId)
        return
    }
  }

  runningOf(threadId: string): number {
    return this.running.get(threadId)?.size ?? 0
  }

  countsOf(threadId: string): SubagentCounts {
    const ended = this.ended.get(threadId) ?? { done: 0, failed: 0 }
    return { running: this.runningOf(threadId), ...ended }
  }

  /** The session is gone: nothing of it is counted any more. */
  clear(threadId: string): void {
    this.running.delete(threadId)
    this.ended.delete(threadId)
  }

  /** The thread was stopped: its subagents count as failed. */
  stopped(threadId: string): void {
    const set = this.running.get(threadId)
    if (!set) return
    for (const id of [...set]) this.end(threadId, id, false)
  }

  private end(threadId: string, toolId: string, ok: boolean): void {
    const set = this.running.get(threadId)
    if (!set?.delete(toolId)) return
    if (set.size === 0) this.running.delete(threadId)
    const ended = this.ended.get(threadId) ?? { done: 0, failed: 0 }
    if (ok) ended.done++
    else ended.failed++
    this.ended.set(threadId, ended)
  }
}

/**
 * Per child root id, whether it told its parent something since its last
 * task. A child with no task in this process is never noted on its own: a
 * restart wake covers it.
 */
export class ChildTaskNotes {
  private readonly told = new Map<string, boolean>()

  task(childId: string): void {
    this.told.set(childId, false)
  }

  /** The child reported, or Switchboard wrote a wake for it. */
  tell(childId: string): void {
    if (this.told.has(childId)) this.told.set(childId, true)
  }

  /** True once per task: the first wake Switchboard writes on its own since the child's last task. */
  claim(childId: string): boolean {
    if (this.told.get(childId) !== false) return false
    this.told.set(childId, true)
    return true
  }
}

export const HUB_REAP_TICK_MS = 60_000
/** Time between SIGTERM and SIGKILL for what is left of a reaped tree. */
const KILL_GRACE_MS = 2_000

export interface HubReaperHost {
  /** The flag and the setting: minutes, or null when reaping is off. */
  idleReapMinutes(): number | null
  /** Open children by parent. */
  openChildren(): Array<{ childId: string; parentId: string }>
  lastWakes(parentId: string): ReadonlyMap<string, { kind: HubWakeKind }>
  liveThread(childId: string): string | null
  /** No turn running, being prepared or outstanding, and no card or question open. */
  idle(threadId: string): boolean
  subagentsRunning(threadId: string): number
  agentPid(threadId: string): number | null
  /** Stops the child's session and keeps what restarts it on its parent's next message. */
  stop(childId: string, threadId: string): Promise<void>
}

export interface HubReaperIo {
  ps(): Promise<string>
  alive(pid: number): boolean
  kill(pid: number, signal: NodeJS.Signals): void
  wait(ms: number): Promise<void>
}

const defaultIo: HubReaperIo = {
  ps: defaultPs,
  alive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      // EPERM: it exists, under another user.
      return (err as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  kill: (pid, signal) => process.kill(pid, signal),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export class HubIdleReaper {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly idleSince = new Map<string, number>()
  private ticking = false

  constructor(
    private readonly host: HubReaperHost,
    private readonly io: HubReaperIo = defaultIo,
    private readonly now: () => number = Date.now,
  ) {}

  start(intervalMs = HUB_REAP_TICK_MS): void {
    if (this.timer || process.platform === 'win32') return
    this.timer = setInterval(() => {
      this.tick().catch((err) => log.warn('idle reap failed', err))
    }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** A turn ended on a thread: its idle time starts now. */
  onTurnEnded(threadId: string): void {
    if (this.idleSince.has(threadId)) this.idleSince.set(threadId, this.now())
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.sweep()
    } finally {
      this.ticking = false
    }
  }

  private async sweep(): Promise<void> {
    const minutes = this.host.idleReapMinutes()
    const children = minutes === null ? [] : this.host.openChildren()
    if (minutes === null || children.length === 0) {
      this.idleSince.clear()
      return
    }
    const now = this.now()
    const seen = new Set<string>()
    const wakesOf = new Map<string, ReadonlyMap<string, { kind: HubWakeKind }>>()
    for (const { childId, parentId } of children) {
      const live = this.host.liveThread(childId)
      if (!live) continue
      seen.add(live)
      if (!this.host.idle(live) || this.host.subagentsRunning(live) > 0) {
        this.idleSince.set(live, now)
        continue
      }
      const since = this.idleSince.get(live) ?? now
      this.idleSince.set(live, since)
      if (!wakesOf.has(parentId)) wakesOf.set(parentId, this.host.lastWakes(parentId))
      if (wakesOf.get(parentId)!.get(childId)?.kind !== 'report') continue
      if (now - since < minutes * 60_000) continue
      this.idleSince.delete(live)
      seen.delete(live)
      await this.reap(childId, parentId, live, now - since)
    }
    for (const id of [...this.idleSince.keys()]) if (!seen.has(id)) this.idleSince.delete(id)
  }

  private async reap(childId: string, parentId: string, threadId: string, idleMs: number): Promise<void> {
    const span = perfSpan('hub.reap', { childId, parentId, idleMin: Math.round(idleMs / 60_000) })
    // Read before the stop: once the agent exits, its children move to another parent.
    const pid = this.host.agentPid(threadId)
    const pids = await treePids(pid, this.io, childId)
    // A parent message may have started a turn while the tree was read.
    if (!this.host.idle(threadId) || this.host.subagentsRunning(threadId) > 0) {
      span.end({ outcome: 'busy', processes: pids.length })
      return
    }
    try {
      await this.host.stop(childId, threadId)
    } catch (err) {
      span.end({ outcome: 'stop_failed', processes: pids.length })
      log.warn(`could not stop idle child ${childId}`, err)
      return
    }
    const killed = await killLeft(pids, this.io)
    span.end({ outcome: 'reaped', processes: pids.length, killed })
    log.info('idle child reaped', { childId, parentId, processes: pids.length, killed })
  }
}

/** The pids of an agent's process tree, read before its session stops: after that its children move to another parent. */
export async function treePids(pid: number | null, io: HubReaperIo = defaultIo, childId = ''): Promise<number[]> {
  if (!pid) return []
  try {
    return (processTree(parsePs(await io.ps()), pid) ?? []).map((r) => r.pid)
  } catch (err) {
    log.warn(`could not list the processes of child ${childId}; only its session is stopped`, err)
    return []
  }
}

/** SIGTERM to every process of `pids` still alive, then SIGKILL to what is left after the grace time. */
export async function killLeft(pids: number[], io: HubReaperIo = defaultIo): Promise<number> {
  const left = pids.filter((p) => p > 1 && p !== process.pid && io.alive(p))
  if (left.length === 0) return 0
  for (const p of left) signal(io, p, 'SIGTERM')
  await io.wait(KILL_GRACE_MS)
  for (const p of left) if (io.alive(p)) signal(io, p, 'SIGKILL')
  return left.length
}

function signal(io: HubReaperIo, pid: number, sig: NodeJS.Signals): void {
  try {
    io.kill(pid, sig)
  } catch (err) {
    log.warn(`could not send ${sig} to ${pid}`, err)
  }
}
