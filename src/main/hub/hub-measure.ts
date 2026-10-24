/**
 * What child chats cost the machine, sampled every 30 s while any child is
 * open: the process tree of each chat's agent (resident memory, CPU %), the
 * total per parent, and the app's own main heap and renderer CPU. Each sample
 * is a `hub.resources` perf line, so limits on running children can use real
 * numbers later; `list_children` shows the newest one.
 *
 * The agent's pid comes from its Switchboard MCP bridge, which reports its
 * parent process when it connects (`SwitchboardMcpServer.agentPid`).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createMainLogger } from '../logger'
import { perfSpan } from '../perf'

const log = createMainLogger('hub:measure')
const execFileP = promisify(execFile)

export const HUB_SAMPLE_INTERVAL_MS = 30_000

export interface ProcessRow {
  pid: number
  ppid: number
  rssKb: number
  cpu: number
}

/** `ps -A -o pid=,ppid=,rss=,%cpu=` output, one row per process. */
export function parsePs(out: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of out.split('\n')) {
    const [pid, ppid, rss, cpu] = line.trim().split(/\s+/).map(Number)
    if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isFinite(rss) && Number.isFinite(cpu))
      rows.push({ pid: pid!, ppid: ppid!, rssKb: rss!, cpu: cpu! })
  }
  return rows
}

export interface TreeUsage {
  rssBytes: number
  cpuPct: number
  processes: number
}

/** The sum over `rootPid` and every process below it, or null when it is gone. */
export function treeUsage(rows: readonly ProcessRow[], rootPid: number): TreeUsage | null {
  const children = new Map<number, ProcessRow[]>()
  let root: ProcessRow | undefined
  for (const r of rows) {
    if (r.pid === rootPid) root = r
    const list = children.get(r.ppid)
    if (list) list.push(r)
    else children.set(r.ppid, [r])
  }
  if (!root) return null
  const usage: TreeUsage = { rssBytes: 0, cpuPct: 0, processes: 0 }
  const stack = [root]
  const seen = new Set<number>()
  while (stack.length) {
    const r = stack.pop()!
    if (seen.has(r.pid)) continue
    seen.add(r.pid)
    usage.rssBytes += r.rssKb * 1024
    usage.cpuPct += r.cpu
    usage.processes++
    stack.push(...(children.get(r.pid) ?? []))
  }
  usage.cpuPct = Math.round(usage.cpuPct * 10) / 10
  return usage
}

export interface ChatResources extends TreeUsage {
  at: number
}

export interface HubResourceSamplerDeps {
  /** Open children and their parents; empty while the flag is off. */
  targets(): Array<{ childId: string; parentId: string }>
  agentPid(threadId: string): number | null
  ps?(): Promise<string>
  appMetrics?(): Array<{ type: string; cpu: { percentCPUUsage: number }; memory: { workingSetSize: number } }> | null
  now?(): number
}

const MB = 1024 * 1024
const mb = (bytes: number) => Math.round(bytes / MB)

export class HubResourceSampler {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly latest = new Map<string, ChatResources>()

  constructor(private readonly deps: HubResourceSamplerDeps) {}

  start(intervalMs = HUB_SAMPLE_INTERVAL_MS): void {
    if (this.timer || process.platform === 'win32') return
    this.timer = setInterval(() => {
      this.tick().catch((err) => log.warn('resource sample failed', err))
    }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** The newest sample of a chat's agent process tree. */
  resourcesOf(threadId: string): ChatResources | undefined {
    return this.latest.get(threadId)
  }

  async tick(): Promise<void> {
    const targets = this.deps.targets()
    if (targets.length === 0) {
      this.latest.clear()
      return
    }
    const rows = parsePs(await (this.deps.ps ?? defaultPs)())
    const at = (this.deps.now ?? Date.now)()
    const parents = new Map<string, TreeUsage>()
    const sampled = new Set<string>()
    const sample = (threadId: string): TreeUsage | null => {
      const pid = this.deps.agentPid(threadId)
      const usage = pid ? treeUsage(rows, pid) : null
      if (usage) {
        this.latest.set(threadId, { ...usage, at })
        sampled.add(threadId)
      }
      return usage
    }
    for (const { childId, parentId } of targets) {
      const usage = sample(childId)
      if (usage) {
        perfSpan('hub.resources', { chat: childId, parent: parentId, role: 'child', ...fields(usage) }).end()
        const total = parents.get(parentId) ?? { rssBytes: 0, cpuPct: 0, processes: 0 }
        parents.set(parentId, {
          rssBytes: total.rssBytes + usage.rssBytes,
          cpuPct: total.cpuPct + usage.cpuPct,
          processes: total.processes + usage.processes,
        })
      }
    }
    for (const [parentId, children] of parents) {
      const own = sample(parentId)
      perfSpan('hub.resources', {
        chat: parentId,
        role: 'parent',
        ...(own ? fields(own) : {}),
        childrenRssMb: mb(children.rssBytes),
        childrenCpuPct: Math.round(children.cpuPct * 10) / 10,
        children: targets.filter((t) => t.parentId === parentId).length,
      }).end()
    }
    for (const id of [...this.latest.keys()]) if (!sampled.has(id)) this.latest.delete(id)
    const metrics = this.deps.appMetrics?.()
    if (metrics) {
      const renderers = metrics.filter((m) => m.type === 'Tab')
      perfSpan('hub.resources', {
        role: 'app',
        mainHeapMb: mb(process.memoryUsage().heapUsed),
        rendererCpuPct: Math.round(renderers.reduce((n, m) => n + m.cpu.percentCPUUsage, 0) * 10) / 10,
        // workingSetSize is in KB.
        appRssMb: Math.round(metrics.reduce((n, m) => n + m.memory.workingSetSize, 0) / 1024),
        openChildren: targets.length,
      }).end()
    }
  }
}

function fields(u: TreeUsage) {
  return { rssMb: mb(u.rssBytes), cpuPct: u.cpuPct, processes: u.processes }
}

async function defaultPs(): Promise<string> {
  return (await execFileP('ps', ['-A', '-o', 'pid=,ppid=,rss=,%cpu='], { maxBuffer: 8 * MB })).stdout
}
