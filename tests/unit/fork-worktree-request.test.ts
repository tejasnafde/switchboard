import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { ExecFileGitWorktreeAdapter } from '../../src/main/worktree-creation/git-adapter'

const run = promisify(execFile)
const roots: string[] = []

function runGit(args: string[], cwd: string) {
  const {
    GIT_DIR: _gitDir,
    GIT_INDEX_FILE: _gitIndexFile,
    GIT_WORK_TREE: _gitWorkTree,
    ...env
  } = process.env
  return run('git', args, { cwd, env })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('fork worktree source semantics', () => {
  it('uses the source worktree HEAD but places the fork under the canonical stable root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sb-fork-git-'))
    roots.push(root)
    const main = join(root, 'main')
    const source = join(root, 'source-worktree')
    await mkdir(main)
    await runGit(['init', '-q'], main)
    await runGit(['config', 'user.email', 'switchboard@example.test'], main)
    await runGit(['config', 'user.name', 'Switchboard Test'], main)
    await writeFile(join(main, 'tracked.txt'), 'base\n')
    await runGit(['add', 'tracked.txt'], main)
    await runGit(['commit', '-qm', 'base'], main)
    await runGit(['worktree', 'add', '-qb', 'source', source], main)
    await writeFile(join(source, 'tracked.txt'), 'dirty\n')
    await writeFile(join(source, 'untracked.txt'), 'new\n')

    const adapter = new ExecFileGitWorktreeAdapter()
    const receipt = await adapter.inspect(source)
    const repository = await adapter.resolveRepository(source)
    const plan = await adapter.planMaterialization({
      repository,
      creationId: 'fork-request-1',
      baseRef: receipt.headSha,
      branch: { namespace: 'fork', seed: 'selected turn' },
      location: 'managed-in-repo',
    })

    expect(receipt).toMatchObject({
      canonicalProjectPath: await realpath(main),
      sourceCheckoutPath: await realpath(source),
      trackedChanges: 1,
      untrackedChanges: 1,
    })
    expect(receipt.omittedChangeSummary).toContain('will not be copied')
    expect(plan.resolvedBaseCommit).toBe(receipt.headSha)
    expect(plan.managedRoot).toBe(join(await realpath(main), '.switchboard', 'worktrees'))
    expect(plan.worktreePath.startsWith(source)).toBe(false)
  })
})
