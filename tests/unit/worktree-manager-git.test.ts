/**
 * The worktree manager against real git repositories: git state, the
 * inventory's ownership and protection, and the removal guard. Every repo
 * lives in a temp dir removed after each test.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorktreeProtection } from '../../src/shared/worktree-manager'
import { findStaleWorktrees, listWorktrees, pathKey, WORKTREE_DIR_REL } from '../../src/main/worktree'
import { WorktreeSizeCache } from '../../src/main/worktree-inspect'
import {
  buildWorktreeInventory,
  removeManagedWorktree,
  updateWorktreeProtection,
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
    updateProtection: (mutate) => (protection = mutate(protection)),
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
  // .native expands Windows 8.3 names (RUNNER~1), which git never prints.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sb-wtmgr-test-')))
  repo = join(root, 'repo')
  git(root, 'init', '-q', '-b', 'main', repo)
  writeFileSync(join(repo, 'README.md'), 'hi\n')
  writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules/\ndist/\n')
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
    const byPath = new Map(rows.map((r) => [pathKey(r.path), r]))
    expect(rows).toHaveLength(3)
    expect(byPath.has(pathKey(repo))).toBe(false)
    expect(byPath.get(pathKey(clean))?.git).toEqual({ uncommittedFiles: 0, ignoredFiles: 0, ignoredSample: [], unpushedCommits: 0, merged: true })
    expect(byPath.get(pathKey(dirty))?.git).toMatchObject({ uncommittedFiles: 2, unpushedCommits: 0 })
    expect(byPath.get(pathKey(ahead))?.git).toEqual({ uncommittedFiles: 0, ignoredFiles: 0, ignoredSample: [], unpushedCommits: 1, merged: false })
  })

  it('marks owned and protected worktrees, and skips a project that is not a git repo', async () => {
    const mine = addWorktree('mine')
    const kept = addWorktree('kept')
    owned = new Set([mine])
    protection = { projects: [], worktrees: [kept] }
    const plain = join(root, 'plain')
    mkdirSync(plain)
    const withPlain = { ...deps(), listProjects: () => [{ path: repo, name: 'repo' }, { path: plain, name: 'plain' }] }
    const { rows, errors } = await buildWorktreeInventory([repo, plain], withPlain)
    expect(errors).toEqual([])
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => pathKey(r.path) === pathKey(mine))?.owned).toBe(true)
    expect(rows.find((r) => pathKey(r.path) === pathKey(kept))?.protectedBy).toBe('worktree')
  })

  it('matches an owned path however it is spelled, so a differently written path never makes a worktree removable', async () => {
    const path = addWorktree('aliased')
    // A directory junction (a symlink elsewhere) gives the same worktree a
    // second spelling, as an 8.3 short name or /var for /private/var does.
    const alias = join(root, 'alias')
    symlinkSync(repo, alias, 'junction')
    owned = new Set([join(alias, WORKTREE_DIR_REL, 'aliased')])
    const { rows } = await buildWorktreeInventory(undefined, deps())
    expect(rows.find((r) => pathKey(r.path) === pathKey(path))?.owned).toBe(true)
    const result = await removeManagedWorktree({ projectPath: repo, worktreePath: path, acknowledged: null }, deps())
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/in use/) })
    expect(existsSync(path)).toBe(true)
  })

  it('reports a locked worktree', async () => {
    const path = addWorktree('locked')
    git(repo, 'worktree', 'lock', path)
    const worktrees = await listWorktrees(repo)
    expect(worktrees).toHaveLength(1)
    expect(worktrees[0].locked).toBe(true)
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
    const ack = { uncommittedFiles: 10, unpushedCommits: 10, ignoredFiles: 10 }
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

    const confirmed = { uncommittedFiles: 1, unpushedCommits: 0, ignoredFiles: 0 }
    writeFileSync(join(path, 'two.txt'), '2\n')
    const stale = await removeManagedWorktree({ ...request, acknowledged: confirmed }, deps())
    expect(stale).toMatchObject({ ok: false, error: expect.stringMatching(/changed since you confirmed/) })
    expect(existsSync(path)).toBe(true)

    expect(await removeManagedWorktree({ ...request, acknowledged: { uncommittedFiles: 2, unpushedCommits: 0, ignoredFiles: 0 } }, deps()))
      .toEqual({ ok: true })
    expect(existsSync(path)).toBe(false)
  })

  it('refuses a truthy acknowledgement with missing counts, keeping the uncommitted files', async () => {
    const path = addWorktree('dirty')
    writeFileSync(join(path, 'work.txt'), 'draft\n')
    const result = await removeManagedWorktree({ projectPath: repo, worktreePath: path, acknowledged: {} as never }, deps())
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/invalid removal confirmation/i) })
    expect(existsSync(join(path, 'work.txt'))).toBe(true)
  })

  it('reports a kept branch as a warning when git refuses to delete it', async () => {
    const path = addWorktree('shared')
    writeFileSync(join(path, 'a.txt'), 'a\n')
    git(path, 'add', '.')
    git(path, 'commit', '-q', '-m', 'shared')
    // Another branch holds the commit, so nothing is unpushed, but main has
    // not merged it, so `git branch -d` refuses.
    git(repo, 'branch', 'keep', 'kanban/shared')
    const result = await removeManagedWorktree({ projectPath: repo, worktreePath: path, acknowledged: null }, deps())
    expect(result).toEqual({ ok: true, warning: expect.stringMatching(/branch kanban\/shared was kept: .*not fully merged/) })
    expect(existsSync(path)).toBe(false)
    expect(branches()).toContain('kanban/shared')
  })

  it('never deletes a branch holding unpushed commits', async () => {
    const path = addWorktree('ahead')
    writeFileSync(join(path, 'a.txt'), 'a\n')
    git(path, 'add', '.')
    git(path, 'commit', '-q', '-m', 'ahead')
    const result = await removeManagedWorktree(
      { projectPath: repo, worktreePath: path, acknowledged: { uncommittedFiles: 0, unpushedCommits: 1, ignoredFiles: 0 } },
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

describe('ignored files', () => {
  it('counts an ignored .env as a loss, but not node_modules or dist', async () => {
    const regen = addWorktree('regen')
    mkdirSync(join(regen, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(regen, 'node_modules', 'x', 'i.js'), '')
    mkdirSync(join(regen, 'dist'))
    writeFileSync(join(regen, 'dist', 'b.js'), '')
    const secret = addWorktree('secret')
    writeFileSync(join(secret, '.env'), 'TOKEN=1\n')

    const { rows } = await buildWorktreeInventory(undefined, deps())
    const byPath = new Map(rows.map((r) => [pathKey(r.path), r]))
    expect(byPath.get(pathKey(regen))?.git).toMatchObject({ uncommittedFiles: 0, ignoredFiles: 0 })
    expect(byPath.get(pathKey(secret))?.git).toMatchObject({ uncommittedFiles: 0, ignoredFiles: 1, ignoredSample: ['.env'] })
  })

  it('keeps an ignored .env until it is acknowledged, and refuses a stale acknowledgement', async () => {
    const path = addWorktree('secret')
    writeFileSync(join(path, '.env'), 'TOKEN=1\n')
    const request = { projectPath: repo, worktreePath: path }
    expect(await removeManagedWorktree({ ...request, acknowledged: null }, deps())).toMatchObject({ ok: false })
    expect(existsSync(join(path, '.env'))).toBe(true)

    mkdirSync(join(path, 'more'))
    writeFileSync(join(path, 'more', 'notes.txt'), 'draft\n')
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'more/\n')
    const stale = await removeManagedWorktree({ ...request, acknowledged: { uncommittedFiles: 0, unpushedCommits: 0, ignoredFiles: 1 } }, deps())
    expect(stale).toMatchObject({ ok: false, error: expect.stringMatching(/changed since you confirmed/) })
    expect(existsSync(join(path, '.env'))).toBe(true)
  })

  it('removes a worktree whose only ignored content is regenerable, without a confirm', async () => {
    const path = addWorktree('regen')
    mkdirSync(join(path, 'node_modules'))
    writeFileSync(join(path, 'node_modules', 'i.js'), '')
    expect(await removeManagedWorktree({ projectPath: repo, worktreePath: path, acknowledged: null }, deps())).toEqual({ ok: true })
    expect(existsSync(path)).toBe(false)
  })
})

describe('protection writes', () => {
  it('keeps both of two concurrent changes', async () => {
    const a = addWorktree('a')
    const b = addWorktree('b')
    // Each protect awaits a git listing before it writes; started together,
    // both reads used to see the empty list and the second write dropped the first.
    await Promise.all([
      updateWorktreeProtection({ target: 'worktree', path: a, protected: true }, deps()),
      updateWorktreeProtection({ target: 'worktree', path: b, protected: true }, deps()),
      updateWorktreeProtection({ target: 'project', path: repo, protected: true }, deps()),
    ])
    expect([...protection.worktrees].sort()).toEqual([a, b].sort())
    expect(protection.projects).toEqual([repo])
  })

  it('clears an entry stored under another spelling', async () => {
    const alias = join(root, 'alias')
    symlinkSync(repo, alias, 'junction')
    protection = { projects: [alias], worktrees: [] }
    await updateWorktreeProtection({ target: 'project', path: repo, protected: false }, deps())
    expect(protection.projects).toEqual([])
  })
})

describe('only configured projects', () => {
  function otherRepoWithWorktree(): { other: string; wt: string } {
    const other = join(root, 'other')
    git(root, 'init', '-q', '-b', 'main', other)
    writeFileSync(join(other, 'README.md'), 'other\n')
    git(other, 'add', '.')
    git(other, 'commit', '-q', '-m', 'init')
    const wt = join(other, WORKTREE_DIR_REL, 'clean')
    git(other, 'worktree', 'add', '-q', '-b', 'kanban/clean', wt)
    return { other, wt }
  }

  it('refuses to remove a clean worktree of a repository that is not a Switchboard project', async () => {
    const { other, wt } = otherRepoWithWorktree()
    const result = await removeManagedWorktree({ projectPath: other, worktreePath: wt, acknowledged: null }, deps())
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/not a project in switchboard/i) })
    expect(existsSync(wt)).toBe(true)
  })

  it('accepts the configured project under another spelling', async () => {
    const path = addWorktree('clean')
    const alias = join(root, 'alias')
    symlinkSync(repo, alias, 'junction')
    expect(await removeManagedWorktree({ projectPath: alias, worktreePath: path, acknowledged: null }, deps())).toEqual({ ok: true })
    expect(existsSync(path)).toBe(false)
  })

  it('lists nothing for an unconfigured project, and says so', async () => {
    const { other } = otherRepoWithWorktree()
    const { rows, errors } = await buildWorktreeInventory([other], deps())
    expect(rows).toEqual([])
    expect(errors).toEqual([{ projectPath: other, message: expect.stringMatching(/not a project in switchboard/i) }])
  })

  it('protects only a configured project or a worktree of one, and unprotects only what is listed', async () => {
    const { other, wt: otherWorktree } = otherRepoWithWorktree()
    await expect(updateWorktreeProtection({ target: 'project', path: other, protected: true }, deps())).rejects.toThrow(/not a project/i)
    await expect(updateWorktreeProtection({ target: 'worktree', path: otherWorktree, protected: true }, deps())).rejects.toThrow(/not a worktree of a project/i)
    await expect(updateWorktreeProtection({ target: 'project', path: other, protected: false }, deps())).rejects.toThrow(/not protected/i)
    expect(protection).toEqual({ projects: [], worktrees: [] })

    const mine = addWorktree('mine')
    await updateWorktreeProtection({ target: 'project', path: repo, protected: true }, deps())
    await updateWorktreeProtection({ target: 'worktree', path: mine, protected: true }, deps())
    expect(protection).toEqual({ projects: [repo], worktrees: [mine] })

    // An entry left behind by a project that is gone can still be cleared.
    protection = { projects: [repo, other], worktrees: [mine] }
    await updateWorktreeProtection({ target: 'project', path: other, protected: false }, deps())
    expect(protection.projects).toEqual([repo])
  })
})

describe('findStaleWorktrees', () => {
  it('never counts a protected or locked worktree as stale', async () => {
    const orphan = addWorktree('orphan')
    const kept = addWorktree('kept')
    const locked = addWorktree('locked')
    git(repo, 'worktree', 'lock', locked)
    const stale = await findStaleWorktrees(repo, new Set(), undefined, { projects: [], worktrees: [kept] })
    expect(stale.map((w) => pathKey(w.path))).toEqual([pathKey(orphan)])
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
