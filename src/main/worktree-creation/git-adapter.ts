import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { cloneDependencyDirsInBackground } from '../git/dependency-clone'
import { createMainLogger } from '../logger'
import type { WorktreeExistingBranchIntent } from '../../shared/worktree-creation'

const log = createMainLogger('worktree:git')

const execFileAsync = promisify(execFile)

export interface ResolvedGitRepository {
  repositoryId: string
  commonGitDir: string
  projectPath: string
}

export interface WorktreeMaterializationIntent {
  repository: ResolvedGitRepository
  creationId: string
  baseRef: string
  branch: {
    namespace: 'sb' | 'fork' | 'kanban'
    seed: string
  }
  location: 'managed-in-repo' | 'managed-user-data'
  userDataDir?: string
  existingBranch?: WorktreeExistingBranchIntent
}

/** An existing-branch checkout. Absent on a plan for a fresh branch. */
export interface ExistingBranchPlan {
  /** The local branch existed before this creation, so no rollback ever deletes it. */
  preexisting: boolean
  /** The local branch is a strict ancestor of the fetched head: move it forward from this commit first. */
  fastForwardFrom?: string
  /** Upstream to record on a branch this creation makes. Only for a fetched branch name, not `refs/...`. */
  upstream?: { remote: string; ref: string }
}

/** Thrown at plan time; the IPC caller sees the message. */
export class BranchCheckedOutError extends Error {
  constructor(branch: string, worktreePath: string) {
    super(
      `Branch ${branch} is already checked out in ${worktreePath}. Work there, or switch that checkout to another branch first.`,
    )
    this.name = 'BranchCheckedOutError'
  }
}

export interface WorktreeMaterializationPlan {
  repository: ResolvedGitRepository
  creationId: string
  requestedBaseRef: string
  resolvedBaseCommit: string
  branch: string
  worktreePath: string
  managedRoot: string
  containmentRoot: string
  existingBranch?: ExistingBranchPlan
}

export type WorktreeMaterializationResult =
  | {
      kind: 'completed'
      worktreePath: string
      branch: string
      headCommit: string
    }
  | {
      kind: 'conflict'
      worktreePath: string
      branch: string
      reason: 'branch_exists' | 'branch_missing' | 'branch_moved' | 'branch_checked_out' | 'path_exists' | 'unsafe_path'
    }
  | {
      kind: 'outcome_unknown'
      worktreePath: string
      branch: string
      reason: string
    }

export type WorktreeMaterializationInspection =
  | { kind: 'absent' }
  | {
      kind: 'branch_only'
      branch: string
      headCommit: string
    }
  | {
      kind: 'exact'
      worktreePath: string
      branch: string
      headCommit: string
    }
  | {
      kind: 'mismatch'
      reason: 'path_mismatch' | 'branch_mismatch'
      observed: {
        worktreePath: string
        branch: string | null
        headCommit: string
      }
    }

export type WorktreeRollbackResult =
  | { kind: 'removed' }
  | { kind: 'absent' }
  | { kind: 'refused'; reason: 'dirty' | 'identity_mismatch' | 'unsafe_path' }

export type WorktreeRollbackMode = 'compensate' | 'explicit_remove'

interface CommandResult {
  stdout: string
  stderr: string
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'worktree'
  )
}

function creationSuffix(creationId: string): string {
  return createHash('sha256').update(creationId).digest('hex').slice(0, 10)
}

function isContained(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return (
    rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel)
  )
}

interface PorcelainWorktree {
  worktreePath: string
  headCommit: string
  branch: string | null
}

function parsePorcelainWorktrees(output: string): PorcelainWorktree[] {
  const worktrees: PorcelainWorktree[] = []
  let current: Partial<PorcelainWorktree> = {}
  const flush = (): void => {
    if (current.worktreePath && current.headCommit) {
      worktrees.push({
        worktreePath: resolve(current.worktreePath),
        headCommit: current.headCommit,
        branch: current.branch ?? null,
      })
    }
    current = {}
  }
  for (const line of `${output}\n`.split('\n')) {
    if (line === '') {
      flush()
    } else if (line.startsWith('worktree ')) {
      current.worktreePath = line.slice('worktree '.length)
    } else if (line.startsWith('HEAD ')) {
      current.headCommit = line.slice('HEAD '.length)
    } else if (line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length)
    }
  }
  return worktrees
}

function normalizeSparseDirectories(directories: string[]): string[] {
  const normalized = directories.map((directory) => {
    if (!directory || directory.includes('\\') || isAbsolute(directory)) {
      throw new Error(`Invalid sparse checkout directory: ${directory}`)
    }
    const parts = directory.split('/')
    if (parts.some((part) => part === '..')) {
      throw new Error(`Invalid sparse checkout directory: ${directory}`)
    }
    const value = parts.filter(Boolean).join('/')
    if (!value || value === '.') throw new Error(`Invalid sparse checkout directory: ${directory}`)
    return value
  })
  return [...new Set(normalized)].sort()
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export class ExecFileGitWorktreeAdapter {
  private async run(cwd: string, args: string[]): Promise<CommandResult> {
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (key.startsWith('GIT_')) delete env[key]
    }
    const result = await execFileAsync('git', ['-c', 'core.hooksPath=', ...args], {
      cwd,
      env,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { stdout: result.stdout, stderr: result.stderr }
  }

  private async succeeds(cwd: string, args: string[]): Promise<boolean> {
    try {
      await this.run(cwd, args)
      return true
    } catch {
      return false
    }
  }

  async inspect(sourceCheckoutPath: string): Promise<{
    canonicalProjectPath: string
    sourceCheckoutPath: string
    headSha: string
    statusDigest: string
    trackedChanges: number
    untrackedChanges: number
    omittedChangeSummary: string
  }> {
    const [repository, head, status] = await Promise.all([
      this.resolveRepository(sourceCheckoutPath),
      this.run(sourceCheckoutPath, ['rev-parse', '--verify', 'HEAD']),
      this.run(sourceCheckoutPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    ])
    const headSha = head.stdout.trim().toLowerCase()
    if (!/^[0-9a-f]{40,64}$/.test(headSha)) throw new Error('Git returned an invalid source HEAD')
    let trackedChanges = 0
    let untrackedChanges = 0
    for (const record of status.stdout.split('\0')) {
      if (record.length < 3 || record[2] !== ' ') continue
      if (record.startsWith('?? ')) untrackedChanges++
      else if (!record.startsWith('!! ')) trackedChanges++
    }
    const parts = [
      trackedChanges > 0 ? `${trackedChanges} tracked change${trackedChanges === 1 ? '' : 's'}` : '',
      untrackedChanges > 0 ? `${untrackedChanges} untracked change${untrackedChanges === 1 ? '' : 's'}` : '',
    ].filter(Boolean)
    return {
      canonicalProjectPath: repository.projectPath,
      sourceCheckoutPath: await realpath(sourceCheckoutPath),
      headSha,
      statusDigest: createHash('sha256').update(status.stdout).digest('hex'),
      trackedChanges,
      untrackedChanges,
      omittedChangeSummary:
        parts.length > 0 ? `${parts.join(' and ')} will not be copied.` : 'The source checkout is clean.',
    }
  }

  async resolveRepository(cwd: string): Promise<ResolvedGitRepository> {
    if (!isAbsolute(cwd)) throw new Error(`Repository path must be absolute: ${cwd}`)
    const [commonResult, worktreesResult] = await Promise.all([
      this.run(cwd, ['rev-parse', '--git-common-dir']),
      this.run(cwd, ['worktree', 'list', '--porcelain']),
    ])
    const rawCommonDir = commonResult.stdout.trim()
    const commonGitDir = await realpath(isAbsolute(rawCommonDir) ? rawCommonDir : resolve(cwd, rawCommonDir))
    const firstWorktree = worktreesResult.stdout
      .split('\n')
      .find((line) => line.startsWith('worktree '))
      ?.slice('worktree '.length)
    if (!firstWorktree) throw new Error(`Git did not report a main worktree for ${cwd}`)
    const projectPath = await realpath(firstWorktree)
    return {
      repositoryId: commonGitDir,
      commonGitDir,
      projectPath,
    }
  }

  private async commitOf(cwd: string, ref: string): Promise<string> {
    const commit = (await this.run(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).stdout.trim()
    if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error(`Git returned an invalid commit for ${ref}`)
    return commit
  }

  private async checkedOutPath(projectPath: string, branch: string): Promise<string | null> {
    const output = (await this.run(projectPath, ['worktree', 'list', '--porcelain'])).stdout
    return parsePorcelainWorktrees(output).find((worktree) => worktree.branch === branch)?.worktreePath ?? null
  }

  /**
   * Resolves an existing-branch checkout without touching any checkout: a
   * fetch writes only a scratch ref, deleted again once read.
   */
  private async planExistingBranch(
    intent: WorktreeMaterializationIntent,
    existing: WorktreeExistingBranchIntent,
  ): Promise<{ commit: string; plan: ExistingBranchPlan }> {
    const cwd = intent.repository.projectPath
    await this.run(cwd, ['check-ref-format', '--branch', existing.name])
    const checkedOut = await this.checkedOutPath(cwd, existing.name)
    if (checkedOut) throw new BranchCheckedOutError(existing.name, checkedOut)

    let fetched: string | undefined
    if (existing.fetch) {
      // Only a configured remote: a bare name git cannot resolve as one is read as a path.
      if (!(await this.succeeds(cwd, ['remote', 'get-url', '--end-of-options', existing.fetch.remote]))) {
        throw new Error(`${cwd} has no remote named ${existing.fetch.remote}.`)
      }
      const scratchRef = `refs/switchboard/fetch/${creationSuffix(intent.creationId)}`
      await this.run(cwd, [
        'fetch',
        '--no-tags',
        '--end-of-options',
        existing.fetch.remote,
        `+${existing.fetch.ref}:${scratchRef}`,
      ])
      try {
        fetched = await this.commitOf(cwd, scratchRef)
      } finally {
        await this.run(cwd, ['update-ref', '-d', scratchRef]).catch((error: unknown) =>
          log.warn('could not delete the scratch fetch ref', {
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      }
    }

    const localRef = `refs/heads/${existing.name}`
    const local = (await this.succeeds(cwd, ['show-ref', '--verify', '--quiet', localRef]))
      ? await this.commitOf(cwd, localRef)
      : null
    if (local) {
      // An older local copy of the head moves forward; a diverged one keeps its own commits.
      if (fetched && fetched !== local && (await this.succeeds(cwd, ['merge-base', '--is-ancestor', local, fetched]))) {
        return { commit: fetched, plan: { preexisting: true, fastForwardFrom: local } }
      }
      return { commit: local, plan: { preexisting: true } }
    }
    if (!fetched) throw new Error(`Branch ${existing.name} does not exist in ${cwd}.`)
    const upstream =
      existing.fetch && !existing.fetch.ref.startsWith('refs/')
        ? { remote: existing.fetch.remote, ref: existing.fetch.ref }
        : undefined
    return { commit: fetched, plan: { preexisting: false, ...(upstream ? { upstream } : {}) } }
  }

  async planMaterialization(intent: WorktreeMaterializationIntent): Promise<WorktreeMaterializationPlan> {
    const existing = intent.existingBranch ? await this.planExistingBranch(intent, intent.existingBranch) : undefined
    const resolvedBaseCommit = existing?.commit ?? (await this.commitOf(intent.repository.projectPath, intent.baseRef))

    const name = `${slug(intent.branch.seed)}-${creationSuffix(intent.creationId)}`
    const branch = intent.existingBranch?.name ?? `${intent.branch.namespace}/${name}`
    let root: string
    let containmentRoot: string
    if (intent.location === 'managed-in-repo') {
      root = join(intent.repository.projectPath, '.switchboard', 'worktrees')
      containmentRoot = intent.repository.projectPath
    } else {
      if (!intent.userDataDir || !isAbsolute(intent.userDataDir)) {
        throw new Error('A managed-user-data worktree requires an absolute userDataDir')
      }
      const repositoryName = slug(intent.repository.projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? 'repository')
      const repositorySuffix = createHash('sha256').update(intent.repository.repositoryId).digest('hex').slice(0, 10)
      root = join(intent.userDataDir, 'worktrees', `${repositoryName}-${repositorySuffix}`)
      containmentRoot = intent.userDataDir
    }

    return {
      repository: intent.repository,
      creationId: intent.creationId,
      requestedBaseRef: intent.baseRef,
      resolvedBaseCommit,
      branch,
      worktreePath: join(root, name),
      managedRoot: root,
      containmentRoot,
      ...(existing ? { existingBranch: existing.plan } : {}),
    }
  }

  private async hasSafeManagedPath(plan: WorktreeMaterializationPlan): Promise<boolean> {
    if (!isContained(resolve(plan.managedRoot), resolve(plan.worktreePath))) return false
    await mkdir(plan.managedRoot, { recursive: true })
    const [physicalRoot, physicalContainer] = await Promise.all([
      realpath(plan.managedRoot),
      realpath(plan.containmentRoot),
    ])
    return isContained(physicalContainer, physicalRoot)
  }

  async materialize(plan: WorktreeMaterializationPlan): Promise<WorktreeMaterializationResult> {
    if (!(await this.hasSafeManagedPath(plan))) {
      return {
        kind: 'conflict',
        branch: plan.branch,
        worktreePath: plan.worktreePath,
        reason: 'unsafe_path',
      }
    }
    const branchExists = await this.succeeds(plan.repository.projectPath, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${plan.branch}`,
    ])
    if (plan.existingBranch?.preexisting && (await this.checkedOutPath(plan.repository.projectPath, plan.branch))) {
      return {
        kind: 'conflict',
        branch: plan.branch,
        worktreePath: plan.worktreePath,
        reason: 'branch_checked_out',
      }
    }
    // A pre-existing branch must still be where the plan saw it (or already moved forward by an earlier try).
    const existingHead =
      plan.existingBranch?.preexisting && branchExists
        ? await this.commitOf(plan.repository.projectPath, `refs/heads/${plan.branch}`)
        : null
    if (
      plan.existingBranch?.preexisting &&
      (!existingHead || ![plan.resolvedBaseCommit, plan.existingBranch.fastForwardFrom].includes(existingHead))
    ) {
      return {
        kind: 'conflict',
        branch: plan.branch,
        worktreePath: plan.worktreePath,
        reason: existingHead ? 'branch_moved' : 'branch_missing',
      }
    }
    if (branchExists && !plan.existingBranch?.preexisting) {
      return {
        kind: 'conflict',
        branch: plan.branch,
        worktreePath: plan.worktreePath,
        reason: 'branch_exists',
      }
    }
    if (await exists(plan.worktreePath)) {
      return {
        kind: 'conflict',
        branch: plan.branch,
        worktreePath: plan.worktreePath,
        reason: 'path_exists',
      }
    }

    await mkdir(dirname(plan.worktreePath), { recursive: true })
    const cwd = plan.repository.projectPath
    try {
      if (plan.existingBranch?.preexisting) {
        const from = plan.existingBranch.fastForwardFrom
        // Compare-and-swap, so a move between the check above and here still fails.
        if (from && existingHead === from) {
          await this.run(cwd, ['update-ref', `refs/heads/${plan.branch}`, plan.resolvedBaseCommit, from])
        }
        await this.run(cwd, ['worktree', 'add', plan.worktreePath, plan.branch])
      } else {
        await this.run(cwd, ['worktree', 'add', '-b', plan.branch, plan.worktreePath, plan.resolvedBaseCommit])
      }
    } catch (error) {
      return {
        kind: 'outcome_unknown',
        branch: plan.branch,
        worktreePath: plan.worktreePath,
        reason: error instanceof Error ? error.message : String(error),
      }
    }

    const upstream = plan.existingBranch?.upstream
    if (upstream) {
      // Lets a plain `git push` / `git pull` in the worktree reach the PR branch. Best effort.
      try {
        await this.run(cwd, ['config', `branch.${plan.branch}.remote`, upstream.remote])
        await this.run(cwd, ['config', `branch.${plan.branch}.merge`, `refs/heads/${upstream.ref}`])
      } catch (error) {
        log.warn('could not set the worktree branch upstream', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const headCommit = (await this.run(plan.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()
    cloneDependencyDirsInBackground(plan.repository.projectPath, plan.worktreePath)
    return {
      kind: 'completed',
      worktreePath: plan.worktreePath,
      branch: plan.branch,
      headCommit,
    }
  }

  async inspectMaterialization(plan: WorktreeMaterializationPlan): Promise<WorktreeMaterializationInspection> {
    const output = (await this.run(plan.repository.projectPath, ['worktree', 'list', '--porcelain'])).stdout
    const worktrees = parsePorcelainWorktrees(output)
    const byPath = worktrees.find((worktree) => worktree.worktreePath === resolve(plan.worktreePath))
    const byBranch = worktrees.find((worktree) => worktree.branch === plan.branch)
    const observed = byPath ?? byBranch
    if (!observed) {
      if (plan.existingBranch?.preexisting) return { kind: 'absent' }
      try {
        const headCommit = (
          await this.run(plan.repository.projectPath, ['rev-parse', '--verify', `refs/heads/${plan.branch}^{commit}`])
        ).stdout.trim()
        return { kind: 'branch_only', branch: plan.branch, headCommit }
      } catch {
        return { kind: 'absent' }
      }
    }
    if (observed.worktreePath !== resolve(plan.worktreePath)) {
      return { kind: 'mismatch', reason: 'path_mismatch', observed }
    }
    if (observed.branch !== plan.branch) {
      return { kind: 'mismatch', reason: 'branch_mismatch', observed }
    }
    return {
      kind: 'exact',
      worktreePath: observed.worktreePath,
      branch: observed.branch,
      headCommit: observed.headCommit,
    }
  }

  async configureSparse(
    plan: WorktreeMaterializationPlan,
    directories: string[],
  ): Promise<{ mode: 'cone'; directories: string[]; status: 'configured' }> {
    const normalized = normalizeSparseDirectories(directories)
    const inspection = await this.inspectMaterialization(plan)
    if (inspection.kind !== 'exact' || inspection.headCommit !== plan.resolvedBaseCommit) {
      throw new Error('Cannot configure sparse checkout for a mismatched worktree')
    }
    await this.run(plan.worktreePath, ['sparse-checkout', 'init', '--cone'])
    await this.run(plan.worktreePath, ['sparse-checkout', 'set', '--cone', '--', ...normalized])
    return { mode: 'cone', directories: normalized, status: 'configured' }
  }

  async rollbackMaterialization(
    plan: WorktreeMaterializationPlan,
    mode: WorktreeRollbackMode = 'compensate',
  ): Promise<WorktreeRollbackResult> {
    if (!(await this.hasSafeManagedPath(plan))) return { kind: 'refused', reason: 'unsafe_path' }
    const inspection = await this.inspectMaterialization(plan)
    if (inspection.kind === 'absent') return { kind: 'absent' }
    if (inspection.kind === 'branch_only') {
      if (inspection.headCommit !== plan.resolvedBaseCommit) {
        return mode === 'compensate' ? { kind: 'refused', reason: 'identity_mismatch' } : { kind: 'removed' }
      }
      await this.run(plan.repository.projectPath, ['branch', '-D', plan.branch])
      return { kind: 'removed' }
    }
    if (inspection.kind !== 'exact') return { kind: 'refused', reason: 'identity_mismatch' }
    if (mode === 'compensate' && inspection.headCommit !== plan.resolvedBaseCommit) {
      return { kind: 'refused', reason: 'identity_mismatch' }
    }
    const status = (await this.run(plan.worktreePath, ['status', '--porcelain', '--untracked-files=all'])).stdout
    if (status.trim().length > 0) return { kind: 'refused', reason: 'dirty' }
    await this.run(plan.repository.projectPath, ['worktree', 'remove', plan.worktreePath])
    if (inspection.headCommit === plan.resolvedBaseCommit && !plan.existingBranch?.preexisting) {
      await this.run(plan.repository.projectPath, ['branch', '-D', plan.branch])
    }
    return { kind: 'removed' }
  }
}
