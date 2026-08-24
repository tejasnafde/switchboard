import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { ExecFileGitWorktreeAdapter } from '../../src/main/worktree-creation/git-adapter'

const execFileAsync = promisify(execFile)
const scratch = new Set<string>()
afterEach(async () => {
  const paths = [...scratch]
  scratch.clear()
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })))
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key]
  }
  const result = await execFileAsync('git', ['-c', 'core.hooksPath=', ...args], {
    cwd,
    env,
    maxBuffer: 4 * 1024 * 1024,
  })
  return result.stdout.trim()
}

async function gitSucceeds(cwd: string, ...args: string[]): Promise<boolean> {
  try {
    await git(cwd, ...args)
    return true
  } catch {
    return false
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function createRepository(): Promise<{
  root: string
  repositoryPath: string
  initialCommit: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'sb-worktree-git-'))
  scratch.add(root)
  const repositoryPath = join(root, 'repository')
  await git(root, 'init', '-b', 'main', repositoryPath)
  await git(repositoryPath, 'config', 'user.name', 'Switchboard Test')
  await git(repositoryPath, 'config', 'user.email', 'switchboard@example.test')
  await writeFile(join(repositoryPath, 'README.md'), 'initial\n', 'utf8')
  await git(repositoryPath, 'add', 'README.md')
  await git(repositoryPath, 'commit', '-m', 'initial')
  return {
    root,
    repositoryPath,
    initialCommit: await git(repositoryPath, 'rev-parse', 'HEAD'),
  }
}

function materializationInput(repository: Awaited<ReturnType<ExecFileGitWorktreeAdapter['resolveRepository']>>) {
  return {
    repository,
    creationId: 'create_01HZY7WP8E4M5D4K7R2S0N9Q1A',
    baseRef: 'HEAD',
    branch: { namespace: 'sb' as const, seed: 'Transactional worktree' },
    location: 'managed-in-repo' as const,
  }
}

describe('ExecFileGitWorktreeAdapter', () => {
  it('binds commands to cwd instead of inherited Git repository control variables', async () => {
    const fixture = await createRepository()
    const previous = process.env.GIT_DIR
    process.env.GIT_DIR = join(fixture.root, 'missing-inherited-git-dir')
    try {
      const repository = await new ExecFileGitWorktreeAdapter().resolveRepository(fixture.repositoryPath)
      expect(repository.projectPath).toBe(await realpath(fixture.repositoryPath))
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previous
    }
  })

  it('resolves the same canonical repository identity from the main checkout and a linked worktree', async () => {
    const fixture = await createRepository()
    const linkedPath = join(fixture.root, 'existing-linked-worktree')
    await git(
      fixture.repositoryPath,
      'worktree',
      'add',
      '-b',
      'existing-linked-worktree',
      linkedPath,
      fixture.initialCommit,
    )
    const adapter = new ExecFileGitWorktreeAdapter()

    const main = await adapter.resolveRepository(fixture.repositoryPath)
    const linked = await adapter.resolveRepository(linkedPath)

    expect(main.repositoryId).toBe(linked.repositoryId)
    expect(main.commonGitDir).toBe(linked.commonGitDir)
  })

  it('materializes the resolved base commit even when the requested branch advances afterward', async () => {
    const fixture = await createRepository()
    const adapter = new ExecFileGitWorktreeAdapter()
    const repository = await adapter.resolveRepository(fixture.repositoryPath)
    const plan = await adapter.planMaterialization(materializationInput(repository))
    expect(plan.resolvedBaseCommit).toBe(fixture.initialCommit)

    await writeFile(join(fixture.repositoryPath, 'README.md'), 'advanced\n', 'utf8')
    await git(fixture.repositoryPath, 'add', 'README.md')
    await git(fixture.repositoryPath, 'commit', '-m', 'advance main')
    expect(await git(fixture.repositoryPath, 'rev-parse', 'HEAD')).not.toBe(fixture.initialCommit)

    const result = await adapter.materialize(plan)

    expect(result).toMatchObject({
      kind: 'completed',
      worktreePath: plan.worktreePath,
      branch: plan.branch,
      headCommit: fixture.initialCommit,
    })
    expect(await git(plan.worktreePath, 'rev-parse', 'HEAD')).toBe(fixture.initialCommit)
  })

  it('derives a deterministic branch and path with a stable creation suffix', async () => {
    const fixture = await createRepository()
    const adapter = new ExecFileGitWorktreeAdapter()
    const repository = await adapter.resolveRepository(fixture.repositoryPath)
    const input = materializationInput(repository)

    const first = await adapter.planMaterialization(input)
    const repeated = await new ExecFileGitWorktreeAdapter().planMaterialization(input)
    const different = await adapter.planMaterialization({
      ...input,
      creationId: 'create_01HZY7WP8E4M5D4K7R2S0N9Q1B',
    })

    expect(repeated.branch).toBe(first.branch)
    expect(repeated.worktreePath).toBe(first.worktreePath)
    expect(first.branch).toMatch(/^sb\/transactional-worktree-[a-z0-9]+$/)
    expect(basename(first.worktreePath)).toBe(first.branch.slice('sb/'.length))
    expect(different.branch).not.toBe(first.branch)
    expect(different.worktreePath).not.toBe(first.worktreePath)
  })

  it('returns a conflict for an unrelated pre-existing branch without adopting or suffixing it', async () => {
    const fixture = await createRepository()
    const adapter = new ExecFileGitWorktreeAdapter()
    const repository = await adapter.resolveRepository(fixture.repositoryPath)
    const plan = await adapter.planMaterialization(materializationInput(repository))
    await git(fixture.repositoryPath, 'branch', plan.branch, fixture.initialCommit)

    const result = await adapter.materialize(plan)

    expect(result).toEqual({
      kind: 'conflict',
      branch: plan.branch,
      worktreePath: plan.worktreePath,
      reason: 'branch_exists',
    })
    const relatedBranches = (await git(
      fixture.repositoryPath,
      'branch',
      '--list',
      `${plan.branch}*`,
      '--format=%(refname:short)',
    )).split('\n').filter(Boolean)
    expect(relatedBranches).toEqual([plan.branch])
  })

  it('inspects absent, branch-only, and exact materialization states', async () => {
    const fixture = await createRepository()
    const adapter = new ExecFileGitWorktreeAdapter()
    const repository = await adapter.resolveRepository(fixture.repositoryPath)
    const plan = await adapter.planMaterialization(materializationInput(repository))

    expect(await adapter.inspectMaterialization(plan)).toEqual({ kind: 'absent' })
    await git(fixture.repositoryPath, 'branch', plan.branch, fixture.initialCommit)

    expect(await adapter.inspectMaterialization(plan)).toEqual({
      kind: 'branch_only',
      branch: plan.branch,
      headCommit: plan.resolvedBaseCommit,
    })
    await git(fixture.repositoryPath, 'branch', '-D', plan.branch)
    await adapter.materialize(plan)

    expect(await adapter.inspectMaterialization(plan)).toEqual({
      kind: 'exact',
      worktreePath: plan.worktreePath,
      branch: plan.branch,
      headCommit: plan.resolvedBaseCommit,
    })
  })

  it('reports identity mismatches instead of adopting a related worktree', async () => {
    const fixture = await createRepository()
    const adapter = new ExecFileGitWorktreeAdapter()
    const repository = await adapter.resolveRepository(fixture.repositoryPath)
    const plan = await adapter.planMaterialization(materializationInput(repository))
    await adapter.materialize(plan)
    const observed = {
      worktreePath: plan.worktreePath,
      branch: plan.branch,
      headCommit: plan.resolvedBaseCommit,
    }

    expect(await adapter.inspectMaterialization({
      ...plan,
      worktreePath: `${plan.worktreePath}-different`,
    })).toEqual({ kind: 'mismatch', reason: 'path_mismatch', observed })
    expect(await adapter.inspectMaterialization({
      ...plan,
      branch: `${plan.branch}-different`,
    })).toEqual({ kind: 'mismatch', reason: 'branch_mismatch', observed })
  })

  it('configures normalized cone sparse directories before later provisioning', async () => {
    const fixture = await createRepository()
    await mkdir(join(fixture.repositoryPath, 'src', 'main'), { recursive: true })
    await mkdir(join(fixture.repositoryPath, 'src', 'renderer'), { recursive: true })
    await mkdir(join(fixture.repositoryPath, 'docs'), { recursive: true })
    await writeFile(join(fixture.repositoryPath, 'src', 'main', 'main.ts'), 'export {}\n', 'utf8')
    await writeFile(join(fixture.repositoryPath, 'src', 'renderer', 'renderer.ts'), 'export {}\n', 'utf8')
    await writeFile(join(fixture.repositoryPath, 'docs', 'internal.md'), 'not selected\n', 'utf8')
    await git(fixture.repositoryPath, 'add', 'src', 'docs')
    await git(fixture.repositoryPath, 'commit', '-m', 'add sparse fixtures')
    const adapter = new ExecFileGitWorktreeAdapter()
    const repository = await adapter.resolveRepository(fixture.repositoryPath)
    const plan = await adapter.planMaterialization(materializationInput(repository))
    await adapter.materialize(plan)

    const receipt = await adapter.configureSparse(plan, [
      'src/renderer/',
      'src//main',
      'src/main',
    ])

    expect(receipt).toEqual({
      mode: 'cone',
      directories: ['src/main', 'src/renderer'],
      status: 'configured',
    })
    expect((await git(plan.worktreePath, 'sparse-checkout', 'list')).split('\n'))
      .toEqual(['src/main', 'src/renderer'])
    expect(await pathExists(join(plan.worktreePath, 'src', 'main', 'main.ts'))).toBe(true)
    expect(await pathExists(join(plan.worktreePath, 'src', 'renderer', 'renderer.ts'))).toBe(true)
    expect(await pathExists(join(plan.worktreePath, 'docs', 'internal.md'))).toBe(false)
  })

  it('rejects a sibling-prefix path outside the derived managed location', async () => {
    const fixture = await createRepository()
    const adapter = new ExecFileGitWorktreeAdapter()
    const repository = await adapter.resolveRepository(fixture.repositoryPath)
    const plan = await adapter.planMaterialization(materializationInput(repository))
    const unsafePath = join(
      fixture.repositoryPath,
      '.switchboard',
      'worktrees-elsewhere',
      basename(plan.worktreePath),
    )

    const result = await adapter.materialize({ ...plan, worktreePath: unsafePath })

    expect(result).toEqual({
      kind: 'conflict',
      branch: plan.branch,
      worktreePath: unsafePath,
      reason: 'unsafe_path',
    })
    expect(await pathExists(unsafePath)).toBe(false)
    expect(await gitSucceeds(
      fixture.repositoryPath,
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${plan.branch}`,
    )).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('rejects a managed-root symlink escape', async () => {
    const fixture = await createRepository()
    const adapter = new ExecFileGitWorktreeAdapter()
    const repository = await adapter.resolveRepository(fixture.repositoryPath)
    const plan = await adapter.planMaterialization(materializationInput(repository))
    const managedParent = join(fixture.repositoryPath, '.switchboard')
    const escapedRoot = join(fixture.root, 'escaped-root')
    await mkdir(managedParent, { recursive: true })
    await mkdir(escapedRoot, { recursive: true })
    await symlink(escapedRoot, join(managedParent, 'worktrees'), 'dir')

    const result = await adapter.materialize(plan)

    expect(result).toEqual({
      kind: 'conflict',
      branch: plan.branch,
      worktreePath: plan.worktreePath,
      reason: 'unsafe_path',
    })
    expect(await pathExists(join(escapedRoot, basename(plan.worktreePath)))).toBe(false)
  })

  it('refuses rollback when the worktree is dirty or the stored identity mismatches', async () => {
    const fixture = await createRepository()
    const adapter = new ExecFileGitWorktreeAdapter()
    const repository = await adapter.resolveRepository(fixture.repositoryPath)
    const plan = await adapter.planMaterialization(materializationInput(repository))
    await adapter.materialize(plan)
    await writeFile(join(plan.worktreePath, 'uncommitted.txt'), 'do not lose me\n', 'utf8')

    expect(await adapter.rollbackMaterialization(plan)).toEqual({
      kind: 'refused',
      reason: 'dirty',
    })
    expect(await pathExists(plan.worktreePath)).toBe(true)

    await rm(join(plan.worktreePath, 'uncommitted.txt'))
    expect(await adapter.rollbackMaterialization({
      ...plan,
      branch: `${plan.branch}-different`,
    })).toEqual({
      kind: 'refused',
      reason: 'identity_mismatch',
    })
    expect(await pathExists(plan.worktreePath)).toBe(true)
  })

  it('rolls back only the exact clean worktree and its exact managed branch', async () => {
    const fixture = await createRepository()
    const adapter = new ExecFileGitWorktreeAdapter()
    const repository = await adapter.resolveRepository(fixture.repositoryPath)
    const plan = await adapter.planMaterialization(materializationInput(repository))
    await adapter.materialize(plan)

    expect(await adapter.rollbackMaterialization(plan)).toEqual({ kind: 'removed' })
    expect(await pathExists(plan.worktreePath)).toBe(false)
    expect(await gitSucceeds(
      fixture.repositoryPath,
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${plan.branch}`,
    )).toBe(false)
  })

  it('refuses automatic compensation after the managed worktree advances but permits explicit removal', async () => {
    const fixture = await createRepository()
    const adapter = new ExecFileGitWorktreeAdapter()
    const repository = await adapter.resolveRepository(fixture.repositoryPath)
    const plan = await adapter.planMaterialization(materializationInput(repository))
    await adapter.materialize(plan)
    await writeFile(join(plan.worktreePath, 'README.md'), 'legitimate work\n', 'utf8')
    await git(plan.worktreePath, 'add', 'README.md')
    await git(plan.worktreePath, 'commit', '-m', 'legitimate worktree commit')
    const advancedHead = await git(plan.worktreePath, 'rev-parse', 'HEAD')

    expect(advancedHead).not.toBe(plan.resolvedBaseCommit)
    expect(await adapter.inspectMaterialization(plan)).toMatchObject({
      kind: 'exact',
      worktreePath: plan.worktreePath,
      branch: plan.branch,
      headCommit: advancedHead,
    })
    expect(await adapter.rollbackMaterialization(plan)).toEqual({
      kind: 'refused',
      reason: 'identity_mismatch',
    })
    expect(await pathExists(plan.worktreePath)).toBe(true)

    expect(await adapter.rollbackMaterialization(plan, 'explicit_remove')).toEqual({ kind: 'removed' })
    expect(await pathExists(plan.worktreePath)).toBe(false)
  })

  it('removes a branch-only partial materialization only at the reserved base commit', async () => {
    const fixture = await createRepository()
    const adapter = new ExecFileGitWorktreeAdapter()
    const repository = await adapter.resolveRepository(fixture.repositoryPath)
    const plan = await adapter.planMaterialization(materializationInput(repository))
    await git(fixture.repositoryPath, 'branch', plan.branch, plan.resolvedBaseCommit)

    expect(await adapter.rollbackMaterialization(plan)).toEqual({ kind: 'removed' })
    expect(await gitSucceeds(
      fixture.repositoryPath,
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${plan.branch}`,
    )).toBe(false)

    await writeFile(join(fixture.repositoryPath, 'README.md'), 'advanced main\n', 'utf8')
    await git(fixture.repositoryPath, 'add', 'README.md')
    await git(fixture.repositoryPath, 'commit', '-m', 'advance main again')
    await git(fixture.repositoryPath, 'branch', plan.branch, 'HEAD')

    expect(await adapter.rollbackMaterialization(plan)).toEqual({
      kind: 'refused',
      reason: 'identity_mismatch',
    })
    expect(await gitSucceeds(
      fixture.repositoryPath,
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${plan.branch}`,
    )).toBe(true)

    expect(await adapter.rollbackMaterialization(plan, 'explicit_remove')).toEqual({ kind: 'removed' })
    expect(await gitSucceeds(
      fixture.repositoryPath,
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${plan.branch}`,
    )).toBe(false)
  })
})
