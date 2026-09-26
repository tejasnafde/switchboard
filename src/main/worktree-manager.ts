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

import type { WorktreeInfo } from '@shared/kanban'
import {
  WORKTREE_PROTECTION_SETTING,
  applyProtectionPatch,
  baseName,
  parseWorktreeProtection,
  removalVerdict,
  type WorktreeChatLink,
  type WorktreeInventory,
  type WorktreeProtection,
  type WorktreeProtectionPatch,
  type WorktreeRemovalAck,
  type WorktreeRow,
} from '@shared/worktree-manager'
import { getDb, getProjects, getSetting, listInUseWorktreePaths, listWorktreeChatLinks, setSetting } from './db/database'
import { listWorktrees, pathKey, protectionFor, removeWorktree, type GitRunner } from './worktree'
import { inspectWorktreeGit, resolveBaseRef, WorktreeSizeCache } from './worktree-inspect'
import { createMainLogger } from './logger'

const log = createMainLogger('worktree:manager')

export interface WorktreeManagerDeps {
  listProjects(): Array<{ path: string; name: string }>
  /** Paths a chat, card, catalog entry or in-flight creation owns. */
  ownedPaths(projectPath: string): Set<string>
  chatLinks(projectPath: string): Map<string, WorktreeChatLink>
  readProtection(): WorktreeProtection
  /**
   * Read, change and write the protection row as one step, so two writers
   * cannot both start from the same old value and lose one change.
   */
  updateProtection(mutate: (current: WorktreeProtection) => WorktreeProtection): WorktreeProtection
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
    // IMMEDIATE takes the write lock before the read, so another process on
    // the same database (a second backend) cannot slip a write in between.
    updateProtection: (mutate) => getDb().transaction(() => {
      const next = mutate(parseWorktreeProtection(getSetting(WORKTREE_PROTECTION_SETTING)))
      setSetting(WORKTREE_PROTECTION_SETTING, JSON.stringify(next))
      return next
    }).immediate(),
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

/**
 * The configured project `path` names, under any spelling, or null. Every
 * channel that takes a project path goes through this, so a caller cannot
 * point the manager at a repository the user never added.
 */
function configuredProject(path: unknown, deps: WorktreeManagerDeps): { path: string; name: string } | null {
  if (typeof path !== 'string' || path === '') return null
  const key = pathKey(path)
  return deps.listProjects().find((p) => pathKey(p.path) === key) ?? null
}

function notConfigured(path: unknown): string {
  return `Not a project in Switchboard: ${String(path)}`
}

function isNotARepo(err: unknown): boolean {
  return /not a git repository/i.test(err instanceof Error ? err.message : String(err))
}

/** Paths from the database, keyed by `pathKey` so git's spelling of them matches. */
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
    owned: new Set([...deps.ownedPaths(projectPath)].map(pathKey)),
    links: new Map([...deps.chatLinks(projectPath)].map(([path, link]) => [pathKey(path), link])),
    protection: deps.readProtection(),
    knownProjectPaths: new Set(projects.map((p) => pathKey(p.path))),
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
  const key = pathKey(wt.path)
  return {
    projectPath: ctx.projectPath,
    projectName: ctx.projectName,
    path: wt.path,
    branch: wt.branch,
    head: wt.head,
    prunable: wt.prunable,
    locked: wt.locked ?? false,
    // A worktree opened as a project of its own is in use by that project.
    owned: ctx.owned.has(key) || ctx.knownProjectPaths.has(key),
    chat: ctx.links.get(key) ?? null,
    protectedBy: protectionFor(ctx.protection, ctx.projectPath, wt.path),
    git,
  }
}

export async function buildWorktreeInventory(
  projectPaths: readonly string[] | undefined,
  deps: WorktreeManagerDeps,
): Promise<WorktreeInventory> {
  const rows: WorktreeRow[] = []
  const errors: WorktreeInventory['errors'] = []
  const paths: string[] = []
  const requestedPaths: readonly unknown[] = projectPaths === undefined
    ? deps.listProjects().map((p) => p.path)
    : Array.isArray(projectPaths) ? projectPaths : [projectPaths]
  for (const requested of requestedPaths) {
    const project = configuredProject(requested, deps)
    if (project) paths.push(project.path)
    else errors.push({ projectPath: String(requested), message: notConfigured(requested) })
  }
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
    const fresh = worktrees.filter((wt) => !seen.has(pathKey(wt.path)))
    if (fresh.length === 0) continue
    for (const wt of fresh) seen.add(pathKey(wt.path))
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
  const project = configuredProject(request?.projectPath, deps)
  if (!project) {
    log.warn(`refused removal in unconfigured project ${String(request?.projectPath)}`)
    return { ok: false, error: notConfigured(request?.projectPath) }
  }
  if (typeof request.worktreePath !== 'string') return { ok: false, error: 'A worktree path is required.' }
  const target = pathKey(request.worktreePath)
  let worktrees: WorktreeInfo[]
  try {
    worktrees = await listWorktrees(project.path, deps.runner)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.warn(`remove: could not list worktrees of ${project.path}: ${error}`)
    return { ok: false, error }
  }
  const wt = worktrees.find((w) => pathKey(w.path) === target)
  if (!wt) return { ok: false, error: `Not a worktree of this repository: ${request.worktreePath}` }

  const row = await toRow(await projectContext(project.path, deps), wt, deps.runner)
  const verdict = removalVerdict(row, request.acknowledged)
  if (!verdict.ok) {
    log.info(`refused to remove ${wt.path}: ${verdict.reason}`)
    return { ok: false, error: verdict.reason }
  }
  try {
    await removeWorktree(project.path, wt.path, { force: verdict.force, deleteBranch: verdict.deleteBranch }, deps.runner)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.warn(`git worktree remove failed for ${wt.path}: ${error}`)
    return { ok: false, error }
  }
  deps.sizes.invalidate(wt.path)
  log.info(`removed worktree ${wt.path}${row.git && (row.git.uncommittedFiles || row.git.ignoredFiles) ? ` (confirmed losing ${row.git.uncommittedFiles} uncommitted, ${row.git.ignoredFiles} ignored)` : ''}`)
  return { ok: true }
}

/**
 * Protecting needs a configured project, or a worktree of one. Unprotecting
 * only needs the path to be in the list, so an entry left behind by a removed
 * project can still be cleared.
 */
export async function updateWorktreeProtection(
  patch: WorktreeProtectionPatch,
  deps: WorktreeManagerDeps,
): Promise<WorktreeProtection> {
  // The checks that await run first; the write below starts from the row as
  // it is at write time, never from a copy read before an await.
  const key = pathKey(patch.path)
  const listIn = (p: WorktreeProtection) => (patch.target === 'project' ? p.projects : p.worktrees)
  const allowed = patch.protected
    ? patch.target === 'project'
      ? configuredProject(patch.path, deps) !== null
      : await isWorktreeOfConfiguredProject(patch.path, deps)
    : listIn(deps.readProtection()).some((p) => pathKey(p) === key)
  if (!allowed) {
    log.warn(`refused to ${patch.protected ? 'protect' : 'unprotect'} ${patch.target} ${patch.path}`)
    throw new Error(patch.protected
      ? `Not a ${patch.target === 'project' ? 'project' : 'worktree of a project'} in Switchboard: ${patch.path}`
      : `Not protected: ${patch.path}`)
  }
  const next = deps.updateProtection((current) => {
    // Drop the path under any spelling first, so an unprotect clears it and a
    // protect never stores it twice.
    const field = patch.target === 'project' ? 'projects' : 'worktrees'
    const without = { ...current, [field]: listIn(current).filter((p) => pathKey(p) !== key) }
    return applyProtectionPatch(without, patch)
  })
  log.info(`${patch.protected ? 'protected' : 'unprotected'} ${patch.target} ${patch.path}`)
  return next
}

async function isWorktreeOfConfiguredProject(path: string, deps: WorktreeManagerDeps): Promise<boolean> {
  const key = pathKey(path)
  for (const project of deps.listProjects()) {
    try {
      if ((await listWorktrees(project.path, deps.runner)).some((wt) => pathKey(wt.path) === key)) return true
    } catch (err) {
      log.debug(`protect: could not list worktrees of ${project.path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return false
}
