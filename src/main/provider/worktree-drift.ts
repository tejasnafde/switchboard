/**
 * Worktree drift detection - pure half. When a session's agent WRITES into a
 * git worktree other than the session's folder, the registry surfaces a
 * worktree.drift event so the user can follow it (one pointer drives the
 * branch chip, IDE pane, terminal cwd, and diff review).
 *
 * Provider-agnostic by construction: it feeds on the normalized tool.started
 * events all three adapters emit. Only the input-shape table below is
 * per-provider, pinned by tests with each adapter's real wire shapes.
 */

/** Tool names that mutate files, lowercase. Reads never signal drift. */
const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit', 'apply_patch', 'patch'])

/** Pull absolute file paths out of a write-tool input, tolerating any shape. */
export function extractWritePaths(toolName: string, input: unknown): string[] {
  if (!WRITE_TOOLS.has(toolName.toLowerCase())) return []
  if (typeof input !== 'object' || input === null) return []
  const obj = input as Record<string, unknown>
  const out: string[] = []
  for (const key of ['file_path', 'notebook_path', 'path', 'filePath']) {
    if (typeof obj[key] === 'string' && obj[key]) out.push(obj[key] as string)
  }
  // Codex fileChange items: { changes: [{ path }, ...] }
  if (Array.isArray(obj.changes)) {
    for (const change of obj.changes) {
      const p = (change as Record<string, unknown> | null)?.path
      if (typeof p === 'string' && p) out.push(p)
    }
  }
  return out
}

export interface WorktreeRef {
  path: string
  branch: string
}

const isUnder = (path: string, root: string): boolean => path === root || path.startsWith(root + '/')

/**
 * First write path that lands in a worktree other than the session folder.
 * Longest-matching worktree root wins so the main repo root does not swallow
 * worktrees nested under it (the .switchboard/worktrees layout).
 */
/** Longest-matching worktree root containing `p`, or null. */
function worktreeOf(p: string, worktrees: WorktreeRef[]): WorktreeRef | null {
  let best: WorktreeRef | null = null
  for (const wt of worktrees) {
    if (isUnder(p, wt.path) && (!best || wt.path.length > best.path.length)) best = wt
  }
  return best
}

export function detectDrift(
  sessionFolder: string,
  paths: string[],
  worktrees: WorktreeRef[]
): WorktreeRef | null {
  // Drift is defined relative to the session's OWN containing worktree, not
  // the raw folder: sessions rooted at a repo subdir writing at the repo root
  // are not drifting, while a worktree-rooted session writing into the main
  // checkout is. Longest-match matters throughout - .switchboard-style
  // worktrees nest under the repo root.
  const home = worktreeOf(sessionFolder, worktrees)
  for (const p of paths) {
    const target = worktreeOf(p, worktrees)
    if (target && target.path !== home?.path) return target
  }
  return null
}

/** Parse `git worktree list --porcelain` output into refs. */
export function parseWorktreeList(stdout: string): WorktreeRef[] {
  const out: WorktreeRef[] = []
  let current: Partial<WorktreeRef> = {}
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) current = { path: line.slice('worktree '.length) }
    else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    else if (line.trim() === '') {
      if (current.path) out.push({ path: current.path, branch: current.branch ?? '(detached)' })
      current = {}
    }
  }
  if (current.path) out.push({ path: current.path, branch: current.branch ?? '(detached)' })
  return out
}

import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import type { RuntimeWorktreeDriftEvent } from '@shared/provider-events'

/**
 * Realpath a path that may not fully exist yet (a Write creates the leaf):
 * resolve the nearest existing ancestor and re-append the tail. Symlinked
 * roots are the norm on macOS - /tmp and /var/folders ARE symlinks into
 * /private, so agent-supplied paths and `git worktree list` output disagree
 * by prefix unless both sides are normalized.
 */
function realpathNearest(p: string): string {
  let dir = p
  const tail: string[] = []
  for (;;) {
    if (existsSync(dir)) {
      try {
        return tail.length ? join(realpathSync(dir), ...tail.reverse()) : realpathSync(dir)
      } catch {
        return p
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return p
    tail.push(basename(dir))
    dir = parent
  }
}

/**
 * Stateful half: dedupe (one event per thread+worktree) over the pure
 * detector. The worktree lister is injected so the registry supplies its
 * cached `git worktree list` and tests supply a real or fake one.
 */
export class DriftWatcher {
  private readonly notified = new Set<string>()

  constructor(private readonly listWorktrees: (repoFolder: string) => Promise<WorktreeRef[]>) {}

  async onToolStarted(
    threadId: string,
    sessionFolder: string,
    toolName: string,
    input: unknown
  ): Promise<RuntimeWorktreeDriftEvent | null> {
    const paths = extractWritePaths(toolName, input)
    if (paths.length === 0) return null
    const worktrees = (await this.listWorktrees(sessionFolder)).map((wt) => ({
      ...wt,
      path: realpathNearest(wt.path),
    }))
    const drift = detectDrift(
      realpathNearest(sessionFolder),
      paths.map(realpathNearest),
      worktrees
    )
    if (!drift) return null
    const key = `${threadId}:${drift.path}`
    if (this.notified.has(key)) return null
    this.notified.add(key)
    return { type: 'worktree.drift', threadId, worktreePath: drift.path, branch: drift.branch }
  }
}
