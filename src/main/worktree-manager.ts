/**
 * The backend half of the worktree manager: one inventory across projects,
 * and the single guarded removal path both the Settings manager and the
 * kanban board's legacy stale cleanup go through.
 *
 * Removal re-lists the repo's worktrees, re-reads ownership, protection and
 * git state, and asks `removalVerdict` again, so nothing the client saw a
 * minute ago decides what is deleted. Deletion is `git worktree remove`
 * (via `removeWorktree`), never a recursive delete.
 */

import { resolve } from 'node:path'
import type { WorktreeInfo } from '@shared/kanban'
import {
  WORKTREE_PROTECTION_SETTING,
  applyProtectionPatch,
  baseName,
  parseWorktreeProtection,
  protectionSource,
  removalVerdict,
  type WorktreeChatLink,
  type WorktreeInventory,
  type WorktreeProtection,
  type WorktreeProtectionPatch,
  type WorktreeRemovalAck,
  type WorktreeRow,
} from '@shared/worktree-manager'
import { getProjects, getSetting, listInUseWorktreePaths, listWorktreeChatLinks, setSetting } from './db/database'
import { listWorktrees, removeWorktree, type GitRunner } from './worktree'
import { inspectWorktreeGit, resolveBaseRef, WorktreeSizeCache } from './worktree-inspect'
import { createMainLogger } from './logger'

const log = createMainLogger('worktree:manager')

export interface WorktreeManagerDeps {
  listProjects(): Array<{ path: string; name: string }>
  /** Paths a chat, card, catalog entry or in-flight creation owns. */
  ownedPaths(projectPath: string): Set<string>
  chatLinks(projectPath: string): Map<string, WorktreeChatLink>
  readProtection(): WorktreeProtection
  writeProtection(protection: WorktreeProtection): void
  sizes: WorktreeSizeCache
  /** Test seam; the default shells out to git. */
  runner?: GitRunner
}

export function defaultWorktreeManagerDeps(): WorktreeManagerDeps {
  return {
    listProjects: () => getProjects(),
    ownedPaths: (projectPath) => listInUseWorktreePaths(projectPath),
    chatLinks: (projectPath) => listWorktreeChatLinks(projectPath),
    readProtection: () => parseWorktreeProtection(getSetting(WORKTREE_PROTECTION_SETTING)),
    writeProtection: (protection) => setSetting(WORKTREE_PROTECTION_SETTING, JSON.stringify(protection)),
    sizes: new WorktreeSizeCache(),
  }
}

const INSPECT_CONCURRENCY = 4

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

function isNotARepo(err: unknown): boolean {
  return /not a git repository/i.test(err instanceof Error ? err.message : String(err))
}

interface ProjectContext {
  projectPath: string
  projectName: string
  owned: Set<string>
  links: Map<string, WorktreeChatLink>
  protection: WorktreeProtection
  knownProjectPaths: Set<string>
  baseRef: string
}

async function projectContext(projectPath: string, deps: WorktreeManagerDeps): Promise<ProjectContext> {
  const projects = deps.listProjects()
  return {
    projectPath,
    projectName: projects.find((p) => p.path === projectPath)?.name || baseName(projectPath),
    owned: deps.ownedPaths(projectPath),
    links: deps.chatLinks(projectPath),
    protection: deps.readProtection(),
    knownProjectPaths: new Set(projects.map((p) => p.path)),
    baseRef: await resolveBaseRef(projectPath, deps.runner),
  }
}

async function toRow(ctx: ProjectContext, wt: WorktreeInfo, runner: GitRunner | undefined): Promise<WorktreeRow> {
  let git: WorktreeRow['git'] = null
  try {
    git = await inspectWorktreeGit(ctx.projectPath, wt, ctx.baseRef, runner)
  } catch (err) {
    log.warn(`git state unreadable for ${wt.path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  return {
    projectPath: ctx.projectPath,
    projectName: ctx.projectName,
    path: wt.path,
    branch: wt.branch,
    head: wt.head,
    prunable: wt.prunable,
    locked: wt.locked ?? false,
    // A worktree opened as a project of its own is in use by that project.
    owned: ctx.owned.has(wt.path) || ctx.knownProjectPaths.has(wt.path),
    chat: ctx.links.get(wt.path) ?? null,
    protectedBy: protectionSource(ctx.protection, ctx.projectPath, wt.path),
    git,
  }
}

export async function buildWorktreeInventory(
  projectPaths: readonly string[] | undefined,
  deps: WorktreeManagerDeps,
): Promise<WorktreeInventory> {
  const paths = projectPaths ?? deps.listProjects().map((p) => p.path)
  const rows: WorktreeRow[] = []
  const errors: WorktreeInventory['errors'] = []
  // Two projects in one repository list the same worktrees; show each once.
  const seen = new Set<string>()
  for (const projectPath of paths) {
    let worktrees: WorktreeInfo[]
    try {
      worktrees = await listWorktrees(projectPath, deps.runner)
    } catch (err) {
      if (isNotARepo(err)) {
        log.debug(`skipping non-git project ${projectPath}`)
      } else {
        const message = err instanceof Error ? err.message : String(err)
        log.warn(`listing worktrees failed for ${projectPath}: ${message}`)
        errors.push({ projectPath, message })
      }
      continue
    }
    const fresh = worktrees.filter((wt) => !seen.has(wt.path))
    if (fresh.length === 0) continue
    for (const wt of fresh) seen.add(wt.path)
    const ctx = await projectContext(projectPath, deps)
    rows.push(...await mapLimit(fresh, INSPECT_CONCURRENCY, (wt) => toRow(ctx, wt, deps.runner)))
  }
  return { rows, errors }
}

export interface WorktreeRemovalRequest {
  projectPath: string
  worktreePath: string
  /** What the user confirmed losing; null for a worktree offered as safe. */
  acknowledged: WorktreeRemovalAck | null
}

export type WorktreeRemovalResult = { ok: true } | { ok: false; error: string }

export async function removeManagedWorktree(
  request: WorktreeRemovalRequest,
  deps: WorktreeManagerDeps,
): Promise<WorktreeRemovalResult> {
  const target = resolve(request.worktreePath)
  let worktrees: WorktreeInfo[]
  try {
    worktrees = await listWorktrees(request.projectPath, deps.runner)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.warn(`remove: could not list worktrees of ${request.projectPath}: ${error}`)
    return { ok: false, error }
  }
  const wt = worktrees.find((w) => w.path === target)
  if (!wt) return { ok: false, error: `Not a worktree of this repository: ${request.worktreePath}` }

  const row = await toRow(await projectContext(request.projectPath, deps), wt, deps.runner)
  const verdict = removalVerdict(row, request.acknowledged)
  if (!verdict.ok) {
    log.info(`refused to remove ${target}: ${verdict.reason}`)
    return { ok: false, error: verdict.reason }
  }
  try {
    await removeWorktree(request.projectPath, target, { force: verdict.force, deleteBranch: verdict.deleteBranch }, deps.runner)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.warn(`git worktree remove failed for ${target}: ${error}`)
    return { ok: false, error }
  }
  deps.sizes.invalidate(target)
  log.info(`removed worktree ${target}${verdict.force ? ` (confirmed losing ${row.git?.uncommittedFiles} files)` : ''}`)
  return { ok: true }
}

export function updateWorktreeProtection(patch: WorktreeProtectionPatch, deps: WorktreeManagerDeps): WorktreeProtection {
  const next = applyProtectionPatch(deps.readProtection(), patch)
  deps.writeProtection(next)
  log.info(`${patch.protected ? 'protected' : 'unprotected'} ${patch.target} ${patch.path}`)
  return next
}
