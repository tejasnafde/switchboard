/**
 * Which repositories a project covers (`shared/project-repos.ts`), the
 * bounded child scan behind it, and resolving an agent's `repoPath` to a work
 * tree really inside the project folder (`main/pull-requests/project-repos.ts`).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

import {
  CHILD_REPO_MAX_LISTED_DIRS,
  coveredRepos,
  findChildRepo,
  projectCoversRepo,
  projectReposFrom,
  scanChildWorkTrees,
  type ChildRepo,
  type ScanEntry,
} from '../../src/shared/project-repos'
import { isWithinFolder, resolveRepoDir, scanChildRepoDirs } from '../../src/main/pull-requests/project-repos'
import { GIT_LOCATION_VARS, type GitRun } from '../../src/main/pull-requests/branch-check'
import type { RepoRef } from '../../src/shared/pull-requests'

const APP: RepoRef = { host: 'github', owner: 'acme', name: 'app' }
const CORE: RepoRef = { host: 'bitbucket', owner: 'geoiq', name: 'geoiq-ssg-core-v1' }
const STUDIO: RepoRef = { host: 'bitbucket', owner: 'geoiq', name: 'geoiq-ssg-studio-v1' }
const child = (relPath: string, repo: RepoRef): ChildRepo => ({ path: `/ssg/${relPath}`, relPath, repo })

describe('which repositories a project covers', () => {
  it('is its own repository when it has one, and never its children then', () => {
    const p = projectReposFrom(APP, [child('vendor/core', CORE)])
    expect(p.children).toEqual([])
    expect(coveredRepos(p)).toEqual([APP])
    expect(projectCoversRepo(p, { ...APP, owner: 'ACME' })).toBe(true)
    expect(projectCoversRepo(p, CORE)).toBe(false)
  })

  it('is every child repository of a folder without one, each once', () => {
    const p = projectReposFrom(null, [child('core', CORE), child('studio', STUDIO), child('core-copy', CORE)])
    expect(coveredRepos(p)).toEqual([CORE, STUDIO])
    expect(projectCoversRepo(p, STUDIO)).toBe(true)
    expect(projectCoversRepo(p, APP)).toBe(false)
    expect(coveredRepos(null)).toEqual([])
    expect(coveredRepos(projectReposFrom(null, []))).toEqual([])
  })

  it('finds zero, one or several child checkouts of a repository', () => {
    const p = projectReposFrom(null, [child('core', CORE), child('studio', STUDIO)])
    expect(findChildRepo(p, [APP])).toEqual({ kind: 'none', candidates: p.children })
    expect(findChildRepo(p, [{ ...STUDIO, name: 'GEOIQ-SSG-STUDIO-V1' }])).toEqual({
      kind: 'one',
      child: p.children[1],
    })
    // "owner/name" without a host is tried as both.
    expect(findChildRepo(p, [{ ...CORE, host: 'github' }, CORE])).toEqual({ kind: 'one', child: p.children[0] })
    const twice = projectReposFrom(null, [child('core', CORE), child('old/core', CORE)])
    expect(findChildRepo(twice, [CORE])).toEqual({ kind: 'many', matches: twice.children })
  })
})

describe('the child scan', () => {
  /** A fake tree: "a/b/" is a directory, "a/b/.git" a work tree marker, "x@" a symlink. */
  function lister(paths: string[]) {
    const listed: string[] = []
    const listDir = async (rel: string): Promise<ScanEntry[]> => {
      listed.push(rel)
      const prefix = rel ? `${rel}/` : ''
      const names = new Map<string, ScanEntry['kind']>()
      for (const p of paths) {
        if (!p.startsWith(prefix)) continue
        const rest = p.slice(prefix.length)
        const [name, ...more] = rest.split('/')
        if (!name) continue
        if (name.endsWith('@')) names.set(name.slice(0, -1), 'symlink')
        else names.set(name, more.length > 0 || rest.endsWith('/') ? 'dir' : name === '.git' ? 'dir' : 'file')
      }
      return [...names].map(([name, kind]) => ({ name, kind }))
    }
    return { listDir, listed }
  }

  it('finds work trees one and two levels down, and does not descend into one', async () => {
    const { listDir, listed } = lister([
      'core/.git/',
      'core/packages/inner/.git/',
      'group/studio/.git/',
      'group/notes.md',
      'deep/a/b/.git/',
      'wt/.git',
      'README.md',
    ])
    expect(await scanChildWorkTrees(listDir)).toEqual(['core', 'wt', 'group/studio'])
    expect(listed).not.toContain('core/packages')
    expect(listed).not.toContain('deep/a/b')
  })

  it('finds nothing in a folder without work trees', async () => {
    expect(await scanChildWorkTrees(lister(['src/index.ts', 'docs/a/b.md']).listDir)).toEqual([])
  })

  it("skips node_modules, hidden folders, the project's own .git and symlinks", async () => {
    const { listDir, listed } = lister([
      '.git/',
      'node_modules/pkg/.git/',
      '.switchboard/worktrees/x/.git/',
      '.cache/r/.git/',
      'link@',
      'real/.git/',
    ])
    expect(await scanChildWorkTrees(listDir)).toEqual(['real'])
    expect(listed.some((d) => d.startsWith('node_modules') || d.startsWith('.') || d === 'link')).toBe(false)
  })

  it('skips an unreadable folder and keeps going', async () => {
    const { listDir } = lister(['locked/', 'ok/.git/'])
    const errors: string[] = []
    const found = await scanChildWorkTrees(
      async (rel) => {
        if (rel === 'locked') throw new Error('EACCES')
        return listDir(rel)
      },
      (rel) => errors.push(rel),
    )
    expect(found).toEqual(['ok'])
    expect(errors).toEqual(['locked'])
  })

  it('stops after a bounded number of listings', async () => {
    const tree = Array.from({ length: 50 }, (_, i) => Array.from({ length: 50 }, (_, j) => `d${i}/e${j}/`)).flat()
    const { listDir, listed } = lister(tree)
    await scanChildWorkTrees(listDir)
    expect(listed.length).toBe(CHILD_REPO_MAX_LISTED_DIRS)
  })
})

describe('on disk', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sb-project-repos-')))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const project = path.join(root, 'ssg')
  const outside = path.join(root, 'outside')
  mkdirSync(path.join(project, 'core', '.git'), { recursive: true })
  mkdirSync(path.join(project, 'group', 'studio', '.git'), { recursive: true })
  mkdirSync(path.join(project, 'node_modules', 'pkg', '.git'), { recursive: true })
  mkdirSync(path.join(outside, 'evil', '.git'), { recursive: true })
  writeFileSync(path.join(project, 'notes.md'), '')
  symlinkSync(path.join(outside, 'evil'), path.join(project, 'escape'))

  const worktree: GitRun = async () => ({ code: 0, stdout: 'true\n', stderr: '' })

  it('scans the real folder without following the symlink out of it', async () => {
    const scanned = await scanChildRepoDirs(project)
    expect(scanned.complete).toBe(true)
    expect(scanned.dirs.sort()).toEqual([path.join(project, 'core'), path.join(project, 'group', 'studio')])
  })

  it('never scans the home folder or a filesystem root', async () => {
    expect(await scanChildRepoDirs(homedir())).toEqual({ dirs: [], complete: true })
    expect(await scanChildRepoDirs(path.parse(root).root)).toEqual({ dirs: [], complete: true })
  })

  it('accepts the folder itself and anything below it, nothing else', () => {
    expect(isWithinFolder(project, project)).toBe(true)
    expect(isWithinFolder(project, path.join(project, 'core'))).toBe(true)
    expect(isWithinFolder(project, path.join(project, '..core'))).toBe(true)
    expect(isWithinFolder(project, root)).toBe(false)
    expect(isWithinFolder(project, `${project}-other`)).toBe(false)
    expect(isWithinFolder(project, outside)).toBe(false)
  })

  it('resolves a relative or absolute repoPath inside the folder', async () => {
    expect(await resolveRepoDir(project, 'core', { realpath: async (p) => realpathSync(p), run: worktree })).toEqual({
      ok: true,
      dir: path.join(project, 'core'),
      relPath: 'core',
      mainRelPath: 'core',
    })
    expect(
      await resolveRepoDir(project, path.join(project, 'group/studio'), {
        realpath: async (p) => realpathSync(p),
        run: worktree,
      }),
    ).toEqual({
      ok: true,
      dir: path.join(project, 'group', 'studio'),
      relPath: 'group/studio',
      mainRelPath: 'group/studio',
    })
    expect(await resolveRepoDir(project, '.', { realpath: async (p) => realpathSync(p), run: worktree })).toEqual({
      ok: true,
      dir: project,
      relPath: '.',
      mainRelPath: '.',
    })
  })

  it('refuses .., an absolute path outside, a symlink out, a missing path and a folder that is not a work tree', async () => {
    const deps = { realpath: async (p: string) => realpathSync(p), run: worktree }
    for (const repoPath of ['../outside/evil', 'core/../../outside/evil', path.join(outside, 'evil'), 'escape']) {
      const r = await resolveRepoDir(project, repoPath, deps)
      expect(r.ok, repoPath).toBe(false)
      if (!r.ok) expect(r.message).toContain("outside this chat's project folder")
    }
    const missing = await resolveRepoDir(project, 'nope', deps)
    expect(missing.ok === false && missing.message).toContain('does not exist')
    const notTree = await resolveRepoDir(project, 'group', {
      ...deps,
      run: async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }),
    })
    expect(notTree.ok === false && notTree.message).toContain('is not a git work tree')
  })
})

describe('a worktree outside the project folder', () => {
  // The native realpath expands a Windows 8.3 short name (RUNNER~1), as fs/promises does.
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'sb-project-wt-')))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const project = path.join(root, 'ssg')
  const core = path.join(project, 'core')
  const other = path.join(root, 'other')
  const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
  for (const name of GIT_LOCATION_VARS) delete gitEnv[name]
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', env: gitEnv })
  for (const repo of [core, other]) {
    mkdirSync(repo, { recursive: true })
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  }
  const tmpWorktree = path.join(root, 'tmp-wt')
  git(core, 'worktree', 'add', '-q', tmpWorktree, '-b', 'feature')
  const otherWorktree = path.join(root, 'other-wt')
  git(other, 'worktree', 'add', '-q', otherWorktree, '-b', 'feature')
  const inProject = path.join(project, '.switchboard', 'worktrees', 'x')
  git(core, 'worktree', 'add', '-q', inProject, '-b', 'inside')
  // A folder that claims to be a worktree of core without being registered in it.
  const forged = path.join(root, 'forged')
  mkdirSync(forged)
  writeFileSync(path.join(forged, '.git'), `gitdir: ${path.join(core, '.git')}\n`)
  symlinkSync(otherWorktree, path.join(project, 'link-out'))

  it('accepts a worktree in another folder whose main checkout is inside the project', async () => {
    expect(await resolveRepoDir(project, tmpWorktree)).toEqual({
      ok: true,
      dir: tmpWorktree,
      relPath: tmpWorktree,
      mainRelPath: 'core',
    })
  })

  it('takes a folder inside a work tree for the work tree', async () => {
    mkdirSync(path.join(core, 'src'), { recursive: true })
    writeFileSync(path.join(core, 'src', 'a.ts'), '')
    expect(await resolveRepoDir(project, 'core/src')).toEqual({
      ok: true,
      dir: core,
      relPath: 'core',
      mainRelPath: 'core',
    })
  })

  it('names the main checkout of a worktree inside the folder', async () => {
    const r = await resolveRepoDir(project, '.switchboard/worktrees/x')
    expect(r).toMatchObject({ ok: true, relPath: '.switchboard/worktrees/x', mainRelPath: 'core' })
  })

  it('refuses a worktree of a repository outside, a symlink to one, and a forged .git file', async () => {
    for (const repoPath of [otherWorktree, other, 'link-out', forged, path.join(tmpWorktree, '..')]) {
      const r = await resolveRepoDir(project, repoPath)
      expect(r.ok, repoPath).toBe(false)
      if (!r.ok) expect(r.message).toContain("outside this chat's project folder")
    }
  })
})
