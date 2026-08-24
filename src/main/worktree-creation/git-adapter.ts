import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

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
      reason: 'branch_exists' | 'path_exists' | 'unsafe_path'
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
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'worktree'
}

function creationSuffix(creationId: string): string {
  return createHash('sha256').update(creationId).digest('hex').slice(0, 10)
}

function isContained(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel)
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

  async planMaterialization(intent: WorktreeMaterializationIntent): Promise<WorktreeMaterializationPlan> {
    const resolvedBaseCommit = (await this.run(intent.repository.projectPath, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${intent.baseRef}^{commit}`,
    ])).stdout.trim()
    if (!/^[0-9a-f]{40,64}$/i.test(resolvedBaseCommit)) {
      throw new Error(`Git returned an invalid commit for ${intent.baseRef}`)
    }

    const name = `${slug(intent.branch.seed)}-${creationSuffix(intent.creationId)}`
    const branch = `${intent.branch.namespace}/${name}`
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
    if (!await this.hasSafeManagedPath(plan)) {
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
    if (branchExists) {
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
    try {
      await this.run(plan.repository.projectPath, [
        'worktree',
        'add',
        '-b',
        plan.branch,
        plan.worktreePath,
        plan.resolvedBaseCommit,
      ])
    } catch (error) {
      return {
        kind: 'outcome_unknown',
        branch: plan.branch,
        worktreePath: plan.worktreePath,
        reason: error instanceof Error ? error.message : String(error),
      }
    }

    const headCommit = (await this.run(plan.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()
    return {
      kind: 'completed',
      worktreePath: plan.worktreePath,
      branch: plan.branch,
      headCommit,
    }
  }

  async inspectMaterialization(plan: WorktreeMaterializationPlan): Promise<WorktreeMaterializationInspection> {
    const output = (await this.run(plan.repository.projectPath, [
      'worktree',
      'list',
      '--porcelain',
    ])).stdout
    const worktrees = parsePorcelainWorktrees(output)
    const byPath = worktrees.find((worktree) => worktree.worktreePath === resolve(plan.worktreePath))
    const byBranch = worktrees.find((worktree) => worktree.branch === plan.branch)
    const observed = byPath ?? byBranch
    if (!observed) {
      try {
        const headCommit = (await this.run(plan.repository.projectPath, [
          'rev-parse',
          '--verify',
          `refs/heads/${plan.branch}^{commit}`,
        ])).stdout.trim()
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
    if (!await this.hasSafeManagedPath(plan)) return { kind: 'refused', reason: 'unsafe_path' }
    const inspection = await this.inspectMaterialization(plan)
    if (inspection.kind === 'absent') return { kind: 'absent' }
    if (inspection.kind === 'branch_only') {
      if (mode === 'compensate' && inspection.headCommit !== plan.resolvedBaseCommit) {
        return { kind: 'refused', reason: 'identity_mismatch' }
      }
      await this.run(plan.repository.projectPath, ['branch', '-D', plan.branch])
      return { kind: 'removed' }
    }
    if (inspection.kind !== 'exact') return { kind: 'refused', reason: 'identity_mismatch' }
    if (mode === 'compensate' && inspection.headCommit !== plan.resolvedBaseCommit) {
      return { kind: 'refused', reason: 'identity_mismatch' }
    }
    const status = (await this.run(plan.worktreePath, [
      'status',
      '--porcelain',
      '--untracked-files=all',
    ])).stdout
    if (status.trim().length > 0) return { kind: 'refused', reason: 'dirty' }
    await this.run(plan.repository.projectPath, ['worktree', 'remove', plan.worktreePath])
    await this.run(plan.repository.projectPath, ['branch', '-D', plan.branch])
    return { kind: 'removed' }
  }
}
