/**
 * The worktree manager against real git repositories: git state, the
 * inventory's ownership and protection, and the removal guard. Every repo
 * lives in a temp dir removed after each test.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorktreeProtection } from '../../src/shared/worktree-manager'
import { findStaleWorktrees, listWorktrees, WORKTREE_DIR_REL } from '../../src/main/worktree'
import { WorktreeSizeCache } from '../../src/main/worktree-inspect'
import {
  buildWorktreeInventory,
  removeManagedWorktree,
  type WorktreeManagerDeps,
} from '../../src/main/worktree-manager'

// Git hooks export GIT_DIR, GIT_INDEX_FILE and friends. Inherited, they point
// every git command here, the code under test's included, at the repository
// being committed to, so they are cleared for this file's run.
const hookGitEnv = Object.entries(process.env).filter(([key]) => key.startsWith('GIT_'))
beforeAll(() => { for (const [key] of hookGitEnv) delete process.env[key] })
afterAll(() => { for (const [key, value] of hookGitEnv) process.env[key] = value })

const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

let root: string
let repo: string
let owned: Set<string>
let protection: WorktreeProtection

function deps(): WorktreeManagerDeps {
  return {
    listProjects: () => [{ path: repo, name: 'repo' }],
    ownedPaths: () => owned,
    chatLinks: () => new Map(),
    readProtection: () => protection,
    writeProtection: (next) => { protection = next },
    sizes: new WorktreeSizeCache(async () => 4096),
  }
}

function addWorktree(name: string): string {
  const path = join(repo, WORKTREE_DIR_REL, name)
  git(repo, 'worktree', 'add', '-q', '-b', `kanban/${name}`, path)
  return path
}

const branches = () => git(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean)

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sb-wtmgr-test-')))
  repo = join(root, 'repo')
  git(root, 'init', '-q', '-b', 'main', repo)
  writeFileSync(join(repo, 'README.md'), 'hi\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
  owned = new Set()
  protection = { projects: [], worktrees: [] }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('worktree inventory', () => {
  it('reads clean, dirty and unpushed worktrees, and never lists the main checkout', async () => {
    const clean = addWorktree('clean')
    const dirty = addWorktree('dirty')
    writeFileSync(join(dirty, 'README.md'), 'changed\n')
    writeFileSync(join(dirty, 'new.txt'), 'new\n')
    const ahead = addWorktree('ahead')
    writeFileSync(join(ahead, 'a.txt'), 'a\n')
    git(ahead, 'add', '.')
    git(ahead, 'commit', '-q', '-m', 'ahead')

    const { rows, errors } = await buildWorktreeInventory(undefined, deps())
    expect(errors).toEqual([])
    const byPath = new Map(rows.map((r) => [r.path, r]))
    expect(byPath.has(repo)).toBe(false)
    expect(byPath.get(clean)?.git).toEqual({ uncommittedFiles: 0, unpushedCommits: 0, merged: true })
    expect(byPath.get(dirty)?.git).toMatchObject({ uncommittedFiles: 2, unpushedCommits: 0 })
    expect(byPath.get(ahead)?.git).toEqual({ uncommittedFiles: 0, unpushedCommits: 1, merged: false })
  })

  it('marks owned and protected worktrees, and skips a project that is not a git repo', async () => {
    const mine = addWorktree('mine')
    const kept = addWorktree('kept')
    owned = new Set([mine])
    protection = { projects: [], worktrees: [kept] }
    const plain = join(root, 'plain')
    mkdirSync(plain)
    const { rows, errors } = await buildWorktreeInventory([repo, plain], deps())
    expect(errors).toEqual([])
    expect(rows.find((r) => r.path === mine)?.owned).toBe(true)
    expect(rows.find((r) => r.path === kept)?.protectedBy).toBe('worktree')
  })

  it('reports a locked worktree', async () => {
    const path = addWorktree('locked')
    git(repo, 'worktree', 'lock', path)
    const [wt] = await listWorktrees(repo)
    expect(wt.locked).toBe(true)
  })
})

describe('removeManagedWorktree', () => {
  it('removes a clean worktree with git worktree remove, and deletes its empty kanban branch', async () => {
    const path = addWorktree('clean')
    expect(await removeManagedWorktree({ projectPath: repo, worktreePath: path, acknowledged: null }, deps())).toEqual({ ok: true })
    expect(existsSync(path)).toBe(false)
    expect(branches()).toEqual(['main'])
  })

  it('refuses an in-use or protected worktree even with an acknowledgement', async () => {
    const path = addWorktree('busy')
    const ack = { uncommittedFiles: 10, unpushedCommits: 10 }
    owned = new Set([path])
    expect(await removeManagedWorktree({ projectPath: repo, worktreePath: path, acknowledged: ack }, deps())).toMatchObject({ ok: false })
    owned = new Set()
    protection = { projects: [repo], worktrees: [] }
    expect(await removeManagedWorktree({ projectPath: repo, worktreePath: path, acknowledged: ack }, deps())).toMatchObject({ ok: false })
    expect(existsSync(path)).toBe(true)
  })

  it('keeps uncommitted work until it is acknowledged, and refuses a stale acknowledgement', async () => {
    const path = addWorktree('dirty')
    writeFileSync(join(path, 'one.txt'), '1\n')
    const request = { projectPath: repo, worktreePath: path }
    expect(await removeManagedWorktree({ ...request, acknowledged: null }, deps())).toMatchObject({ ok: false })
    expect(existsSync(join(path, 'one.txt'))).toBe(true)

    const confirmed = { uncommittedFiles: 1, unpushedCommits: 0 }
    writeFileSync(join(path, 'two.txt'), '2\n')
    const stale = await removeManagedWorktree({ ...request, acknowledged: confirmed }, deps())
    expect(stale).toMatchObject({ ok: false, error: expect.stringMatching(/changed since you confirmed/) })
    expect(existsSync(path)).toBe(true)

    expect(await removeManagedWorktree({ ...request, acknowledged: { uncommittedFiles: 2, unpushedCommits: 0 } }, deps()))
      .toEqual({ ok: true })
    expect(existsSync(path)).toBe(false)
  })

  it('never deletes a branch holding unpushed commits', async () => {
    const path = addWorktree('ahead')
    writeFileSync(join(path, 'a.txt'), 'a\n')
    git(path, 'add', '.')
    git(path, 'commit', '-q', '-m', 'ahead')
    const result = await removeManagedWorktree(
      { projectPath: repo, worktreePath: path, acknowledged: { uncommittedFiles: 0, unpushedCommits: 1 } },
      deps(),
    )
    expect(result).toEqual({ ok: true })
    expect(existsSync(path)).toBe(false)
    expect(branches()).toContain('kanban/ahead')
  })

  it('refuses a path that is not one of the repo\'s worktrees', async () => {
    const result = await removeManagedWorktree({ projectPath: repo, worktreePath: join(root, 'elsewhere'), acknowledged: null }, deps())
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/not a worktree/i) })
  })
})

describe('findStaleWorktrees', () => {
  it('never counts a protected or locked worktree as stale', async () => {
    const orphan = addWorktree('orphan')
    const kept = addWorktree('kept')
    const locked = addWorktree('locked')
    git(repo, 'worktree', 'lock', locked)
    const stale = await findStaleWorktrees(repo, new Set(), undefined, { projects: [], worktrees: [kept] })
    expect(stale.map((w) => w.path)).toEqual([orphan])
    expect(await findStaleWorktrees(repo, new Set(), undefined, { projects: [repo], worktrees: [] })).toEqual([])
  })
})

describe('WorktreeSizeCache', () => {
  it('caches, shares an in-flight probe, and re-measures on refresh', async () => {
    const probe = vi.fn(async () => 100)
    const cache = new WorktreeSizeCache(probe)
    const [a, b] = await Promise.all([cache.get('/w'), cache.get('/w')])
    expect([a, b]).toEqual([100, 100])
    await cache.get('/w')
    expect(probe).toHaveBeenCalledTimes(1)
    await cache.get('/w', { refresh: true })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('runs at most two probes at once', async () => {
    let running = 0
    let peak = 0
    const cache = new WorktreeSizeCache(async () => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running -= 1
      return 1
    })
    await Promise.all(['/1', '/2', '/3', '/4', '/5'].map((p) => cache.get(p)))
    expect(peak).toBe(2)
  })

  it('answers null when the probe fails', async () => {
    const cache = new WorktreeSizeCache(async () => { throw new Error('du: no such file') })
    expect(await cache.get('/missing')).toBeNull()
  })

  it('measures a real directory with the default probe', async () => {
    writeFileSync(join(repo, 'big.bin'), Buffer.alloc(64 * 1024))
    const bytes = await new WorktreeSizeCache().get(repo)
    expect(bytes).toBeGreaterThanOrEqual(64 * 1024)
  })
})
