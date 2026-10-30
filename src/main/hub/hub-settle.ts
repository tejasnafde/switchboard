/**
 * Settle: a parent's children end, and with them the worktrees nobody needs.
 *
 * Per child: its start is cancelled, its turn, cards, queued messages and
 * auto-resume stop (`HubSettleHost.stop`, the `interrupt_child` path), then its
 * session and what is left of its agent's process tree. It moves to phase
 * `settled` and is archived. Its worktree goes only when it is clean, its
 * HEAD is in the parent's HEAD and no other chat or card works in it
 * (`settleWorktree`); the dependency links go first, then the worktree
 * creation service removes it and refuses a dirty one again. A branch with
 * commits stays (one still at its base commit goes with the worktree);
 * nothing is pushed.
 *
 * Also here: the `conflicts` of `list_children`, from `git merge-tree
 * --write-tree` (git 2.38 or later; null before) between each child and the
 * parent's HEAD and between each pair of children.
 *
 * Measured: one `hub.settle` perf line per settle (children, removed, kept,
 * stop failures, killed processes) and one `hub.conflicts` per scan (pairs,
 * conflicting pairs).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { hubSettleResult, settleBlockers, settleWorktree, type HubSettleRowView, type HubSettleView } from '@shared/hub'
import {
  archiveConversation,
  getConversationById,
  getLimitResume,
  listHubChildren,
  otherWorktreeUsers,
  updateHubChild,
  type HubChildRow,
} from '../db/database'
import { removeDependencyLinks } from '../git/dependency-links'
import { createMainLogger } from '../logger'
import { perfSpan } from '../perf'
import { hubWorktrees } from './hub-start'
import { killLeft, treePids } from './hub-stop'

const log = createMainLogger('hub:settle')
const execFileP = promisify(execFile)

/** A settle card as it is stored: the approval settles `parentId`'s children as they are then. */
export interface HubSettlePlan {
  kind: 'hub-settle'
  parentId: string
  view: HubSettleView
}

export function isHubSettlePlan(plan: { kind: string }): plan is HubSettlePlan {
  return plan.kind === 'hub-settle'
}

export interface HubSettleHost {
  /** What is open on the child's session now. */
  sessionFacts(childId: string): { running: boolean; cards: number; queued: number }
  agentPid(childId: string): number | null
  /** Stops the child as `interrupt_child` does (no wake), then its session. */
  stop(childId: string): Promise<void>
  /** Lineage edges, the sidebar and the hub views read the children again. */
  changed(parentId: string): void
  /** Drop what the process keeps about a settled child. */
  forget(childId: string): void
}

export interface HubSettleIo {
  /** Exit code and stdout of a git command; never throws for a non-zero exit. */
  git(cwd: string, args: string[]): Promise<{ code: number; stdout: string }>
}

export type HubSettleResult = { ok: true; text: string; rows: HubSettleRowView[] } | { ok: false; text: string }

export class HubSettler {
  private readonly running = new Set<string>()

  constructor(
    private readonly host: HubSettleHost,
    private readonly io: HubSettleIo = { git: runGit },
  ) {}

  /** What a settle of `parentId`'s unsettled children would do now, for the card. */
  async plan(parentId: string, parentCwd: string, archiveParent: boolean): Promise<HubSettleView> {
    const children = listHubChildren(parentId)
    return { rows: await Promise.all(children.map((c) => this.row(c, parentCwd))), archiveParent }
  }

  /** `only`: the children a card showed; a child started after it stays open. */
  async run(
    parentId: string,
    parentCwd: string,
    how: 'card' | 'auto',
    only?: ReadonlySet<string>,
  ): Promise<HubSettleResult> {
    if (this.running.has(parentId)) return { ok: false, text: 'A settle of these children is already running.' }
    const all = listHubChildren(parentId)
    const children = only ? all.filter((c) => only.has(c.childId)) : all
    if (children.length === 0) return { ok: true, text: 'This chat has no children to settle.', rows: [] }
    this.running.add(parentId)
    const span = perfSpan('hub.settle', { parentId, children: children.length, how })
    try {
      const stops = await Promise.allSettled(children.map((c) => this.stop(c.childId)))
      // A child that did not stop may still run: it stays open, and the settle says so.
      const failed = children.filter((_, i) => stops[i]!.status === 'rejected')
      for (const s of stops) if (s.status === 'rejected') log.warn('a child did not stop for its settle', s.reason)
      const stopped = children.filter((c) => !failed.includes(c))
      // Read after the stops, so an agent cut off mid-write is judged by what it left.
      const rows = await Promise.all(stopped.map((c) => this.row(c, parentCwd)))
      for (const [i, child] of stopped.entries()) {
        updateHubChild(child.childId, {
          phase: 'settled',
          settledAt: Date.now(),
          settleJson: JSON.stringify({ worktree: rows[i]!.worktree, keepReason: rows[i]!.keepReason ?? null }),
        })
        archiveConversation(child.childId)
        this.host.forget(child.childId)
      }
      this.host.changed(parentId)
      for (const [i, row] of rows.entries()) {
        if (row.worktree !== 'remove') continue
        const problem = await this.removeWorktree(stopped[i]!)
        if (problem) Object.assign(row, { worktree: 'keep', keepReason: problem })
      }
      const removed = rows.filter((r) => r.worktree === 'remove').length
      const kept = rows.filter((r) => r.worktree === 'keep').length
      const killed = stops.reduce((n, s) => n + (s.status === 'fulfilled' ? s.value : 0), 0)
      span.end({ outcome: 'settled', removed, kept, stopFailed: failed.length, killed })
      log.info('children settled', {
        parentId,
        children: stopped.length,
        removed,
        kept,
        stopFailed: failed.length,
        how,
      })
      const text = hubSettleResult(rows)
      if (failed.length === 0) return { ok: true, text, rows }
      return {
        ok: false,
        text: `${text}\nNot settled, since they did not stop: ${failed.map((c) => c.title).join(', ')}. Stop them, then settle again.`,
      }
    } catch (err) {
      span.end({ outcome: 'failed' })
      throw err
    } finally {
      this.running.delete(parentId)
    }
  }

  /** The child's stop, then the rest of its agent's process tree. The processes killed. */
  private async stop(childId: string): Promise<number> {
    const pids = await treePids(this.host.agentPid(childId), undefined, childId)
    await this.host.stop(childId)
    return killLeft(pids)
  }

  private async row(child: HubChildRow, parentCwd: string): Promise<HubSettleRowView> {
    const worktreePath =
      child.location === 'worktree' ? (getConversationById(child.childId)?.worktree_path ?? null) : null
    let merged: boolean | null = null
    let clean: boolean | null = null
    if (worktreePath) {
      const [head, status] = await Promise.all([
        this.io.git(worktreePath, ['rev-parse', 'HEAD']),
        this.io.git(worktreePath, ['status', '--porcelain', '--untracked-files=all']),
      ])
      if (status.code === 0) clean = status.stdout.trim() === ''
      if (head.code === 0) {
        const r = await this.io.git(parentCwd, ['merge-base', '--is-ancestor', head.stdout.trim(), 'HEAD'])
        merged = r.code === 0 ? true : r.code === 1 ? false : null
      }
    }
    const starting = child.phase === 'starting'
    return {
      childId: child.childId,
      title: child.title,
      branch: child.branch,
      merged,
      clean,
      blockers: settleBlockers({
        ...this.host.sessionFacts(child.childId),
        starting,
        resumeArmed: getLimitResume(child.childId)?.state === 'armed',
      }),
      ...settleWorktree({
        location: child.location,
        worktreePath,
        starting,
        merged,
        clean,
        sharedWith: worktreePath ? otherWorktreeUsers(worktreePath, child.childId) : 0,
      }),
    }
  }

  /** Null when the worktree is gone; else why it stays. */
  private async removeWorktree(child: HubChildRow): Promise<string | null> {
    const service = hubWorktrees()
    if (!service) return 'the worktree service is not ready'
    const worktree = getConversationById(child.childId)?.worktree_path
    const key = { machineId: 'local', creationId: child.creationId ?? `${child.batchId}-${child.ordinal}` }
    try {
      // A chat may have opened the worktree since the plan read it.
      if (worktree && otherWorktreeUsers(worktree, child.childId) > 0) return 'another chat or card works in it'
      if (worktree) await removeDependencyLinks(worktree)
      const snapshot = await service.getWorktreeCreation(key)
      const done = await service.actOnWorktreeCreation({
        ...key,
        expectedRevision: snapshot.revision,
        action: 'remove',
      })
      if (done.cleanupDisposition === 'removed') return null
      return done.error?.message ?? 'git refused to remove it'
    } catch (err) {
      log.warn(`could not remove the worktree of settled child ${child.childId}`, err)
      return err instanceof Error ? err.message : String(err)
    }
  }
}

// ─── Conflicts ──────────────────────────────────────────────────

export interface ChildConflict {
  /** The other child's title, or "this chat" for the parent's HEAD. */
  with: string
  files: string[]
}

/** git 2.38 added `merge-tree --write-tree`. */
const MERGE_TREE_MIN: readonly [number, number] = [2, 38]
let mergeTreeSupport: Promise<boolean> | null = null

function supportsMergeTree(io: HubSettleIo, cwd: string): Promise<boolean> {
  mergeTreeSupport ??= io.git(cwd, ['version']).then((r) => {
    const m = /(\d+)\.(\d+)/.exec(r.stdout)
    // A failed read (a folder that is gone) is asked again next time.
    if (r.code !== 0) mergeTreeSupport = null
    if (!m) return false
    const [major, minor] = [Number(m[1]), Number(m[2])]
    return major > MERGE_TREE_MIN[0] || (major === MERGE_TREE_MIN[0] && minor >= MERGE_TREE_MIN[1])
  })
  return mergeTreeSupport
}

/**
 * Per child id, the files it conflicts on with the parent's HEAD and with
 * each other child; null for a child a check could not read. Children
 * without a worktree HEAD are left out. Null when this git cannot tell
 * (older than 2.38).
 */
export async function childConflicts(
  parentId: string,
  parentCwd: string,
  heads: ReadonlyArray<{ childId: string; title: string; worktree: string }>,
  io: HubSettleIo = { git: runGit },
): Promise<Map<string, ChildConflict[] | null> | null> {
  if (!(await supportsMergeTree(io, parentCwd))) return null
  const span = perfSpan('hub.conflicts', { parentId, children: heads.length })
  const shas = await Promise.all(heads.map((h) => io.git(h.worktree, ['rev-parse', 'HEAD'])))
  const sides = heads.flatMap((h, i) =>
    shas[i]!.code === 0 ? [{ id: h.childId, title: h.title, sha: shas[i]!.stdout.trim() }] : [],
  )
  const parentHead = await io.git(parentCwd, ['rev-parse', 'HEAD'])
  const others = parentHead.code === 0 ? [{ id: '', title: 'this chat', sha: parentHead.stdout.trim() }] : []
  const pairs: Array<[(typeof sides)[number], (typeof sides)[number]]> = []
  sides.forEach((a, i) => {
    for (const b of [...others, ...sides.slice(i + 1)]) pairs.push([a, b])
  })
  const out = new Map<string, ChildConflict[] | null>(sides.map((s) => [s.id, parentHead.code === 0 ? [] : null]))
  let conflicting = 0
  for (const [a, b] of pairs) {
    if (a.sha === b.sha) continue
    const r = await io.git(parentCwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', a.sha, b.sha])
    // 0: merges cleanly, 1: conflicts; anything else (a timeout) leaves both sides unknown.
    if (r.code !== 0 && r.code !== 1) {
      out.set(a.id, null)
      if (b.id) out.set(b.id, null)
    }
    if (r.code !== 1) continue
    const files = r.stdout.split('\n').slice(1).filter(Boolean)
    conflicting++
    out.get(a.id)?.push({ with: b.title, files })
    if (b.id) out.get(b.id)?.push({ with: a.title, files })
  }
  span.end({ pairs: pairs.length, conflicting })
  return out
}

/** One git call of a settle or a conflict scan; past it the call counts as unknown. */
const GIT_TIMEOUT_MS = 20_000

async function runGit(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileP('git', ['-C', cwd, ...args], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
    })
    return { code: 0, stdout }
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string }
    if (typeof e.code === 'number') return { code: e.code, stdout: e.stdout ?? '' }
    log.warn(`git ${args[0]} failed in ${cwd}`, err)
    return { code: -1, stdout: '' }
  }
}
