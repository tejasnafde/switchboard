import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/launch-config/launch-config-store', () => ({ readLaunchConfig: () => null }))

import {
  checkChildDeps,
  depsBriefLine,
  depsRule,
  depsSummary,
  frozenInstallCommand,
  linkedDependencyAt,
  npmTreeMatches,
  ownChildDeps,
  planChildDeps,
  prepareChildDeps,
  trackDependencyLinks,
  untrackDependencyLinks,
  type DepsFolderFacts,
} from '../../src/main/hub/hub-deps'
import { readLinkManifest } from '../../src/main/git/dependency-links'
import { removeWorktree } from '../../src/main/worktree'

const facts = (extra: Partial<DepsFolderFacts> = {}): DepsFolderFacts => ({
  setting: 'link',
  platform: 'darwin',
  extra: false,
  installScript: false,
  workspaces: false,
  hasLockfile: true,
  baseMatches: true,
  installedMatches: true,
  ...extra,
})

describe('depsRule (L1 to L5)', () => {
  it('links a plain npm folder whose base and installed tree match', () => {
    expect(depsRule(facts())).toEqual({ mode: 'link', reason: null })
    expect(depsRule(facts({ platform: 'linux', installedMatches: null }))).toEqual({ mode: 'link', reason: null })
  })

  it('moves down the chain for each rule', () => {
    expect(depsRule(facts({ installScript: true })).mode).toBe('clone')
    expect(depsRule(facts({ workspaces: true })).mode).toBe('clone')
    expect(depsRule(facts({ hasLockfile: false })).mode).toBe('clone')
    expect(depsRule(facts({ installedMatches: false })).mode).toBe('clone')
    expect(depsRule(facts({ baseMatches: false })).mode).toBe('install')
    expect(depsRule(facts({ platform: 'win32' })).mode).toBe('install')
  })

  it('never goes above the setting', () => {
    expect(depsRule(facts({ setting: 'clone' })).mode).toBe('clone')
    expect(depsRule(facts({ setting: 'install' })).mode).toBe('install')
    expect(depsRule(facts({ setting: 'none' })).mode).toBe('none')
    expect(depsRule(facts({ setting: 'clone', baseMatches: false })).mode).toBe('install')
  })

  it('links a worktree.link path, or leaves it out', () => {
    expect(depsRule(facts({ extra: true })).mode).toBe('link')
    expect(depsRule(facts({ extra: true, platform: 'win32' })).mode).toBe('none')
    expect(depsRule(facts({ extra: true, setting: 'none' })).mode).toBe('none')
  })

  it('summarises a child by its heaviest folder', () => {
    expect(depsSummary([])).toBe('none')
    expect(depsSummary(['link', 'clone', 'link'])).toBe('clone')
    expect(depsSummary(['link', 'install'])).toBe('install')
  })
})

describe('frozenInstallCommand', () => {
  it('runs the package manager through a shell only on Windows', () => {
    expect(frozenInstallCommand('package-lock.json', 'darwin')).toEqual({ cmd: 'npm', args: ['ci'], shell: false })
    expect(frozenInstallCommand('pnpm-lock.yaml', 'win32')).toEqual({
      cmd: 'pnpm',
      args: ['install', '--frozen-lockfile'],
      shell: true,
    })
  })
})

describe('npmTreeMatches', () => {
  const lock = (pkgs: Record<string, object>) => JSON.stringify({ packages: { '': {}, ...pkgs } })
  it('matches when every installed and every required entry agree', () => {
    const l = lock({ 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: '2.0.0', optional: true } })
    expect(npmTreeMatches(l, lock({ 'node_modules/a': { version: '1.0.0' } }))).toBe(true)
    expect(npmTreeMatches(l, lock({ 'node_modules/a': { version: '1.0.1' } }))).toBe(false)
    expect(npmTreeMatches(l, lock({}))).toBe(false)
    expect(npmTreeMatches(l, '{')).toBe(false)
  })
})

describe('linkedDependencyAt', () => {
  afterEach(() => untrackDependencyLinks('child'))
  it('finds a path inside a tracked link and nothing outside', () => {
    trackDependencyLinks('child', '/repo/.switchboard/worktrees/c', {
      folders: [{ path: 'node_modules', pkgDir: '', mode: 'link', reason: null }],
    })
    expect(linkedDependencyAt('/repo/.switchboard/worktrees/c/node_modules/x/index.js')).toBe(
      '/repo/.switchboard/worktrees/c/node_modules',
    )
    expect(linkedDependencyAt('/repo/.switchboard/worktrees/c/src/a.ts')).toBeNull()
    expect(linkedDependencyAt('/repo/.switchboard/worktrees/c/node_modules_other')).toBeNull()
  })
})

describe.skipIf(process.platform === 'win32')('a child worktree with linked node_modules', () => {
  let main: string
  let wt: string
  let base: string
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const lockText = JSON.stringify({ packages: { '': {}, 'node_modules/a': { version: '1.0.0' } } })

  beforeEach(() => {
    main = realpathSync(mkdtempSync(join(tmpdir(), 'sb-hub-deps-')))
    git(main, 'init', '-q', '-b', 'main')
    git(main, 'config', 'user.email', 't@example.com')
    git(main, 'config', 'user.name', 'T')
    // A trailing slash pattern, as in this repo's own .gitignore: git does not apply it to a symlink.
    writeFileSync(join(main, '.gitignore'), 'node_modules/\napps/mobile/node_modules/\n.switchboard/\n')
    for (const dir of ['', 'apps/mobile']) {
      mkdirSync(join(main, dir, 'node_modules', 'a'), { recursive: true })
      writeFileSync(join(main, dir, 'package.json'), JSON.stringify({ name: dir || 'root' }))
      writeFileSync(join(main, dir, 'package-lock.json'), lockText)
      writeFileSync(join(main, dir, 'node_modules', '.package-lock.json'), lockText)
      writeFileSync(join(main, dir, 'node_modules', 'a', 'index.js'), 'module.exports = 1\n')
    }
    git(main, 'add', '-A')
    git(main, 'commit', '-q', '-m', 'init')
    base = git(main, 'rev-parse', 'HEAD')
    wt = join(main, '.switchboard', 'worktrees', 'child')
    git(main, 'worktree', 'add', '-q', '-b', 'hub/child', wt, base)
  })

  afterEach(() => {
    rmSync(main, { recursive: true, force: true })
  })

  it('links both folders, keeps git status clean, and the child reads through the link', async () => {
    const plans = await planChildDeps(main, base, 'link', 'darwin')
    expect(plans.map((p) => [p.path, p.mode])).toEqual([
      ['node_modules', 'link'],
      ['apps/mobile/node_modules', 'link'],
    ])
    const state = await prepareChildDeps(main, wt, plans)
    expect(state.folders.every((f) => f.mode === 'link')).toBe(true)
    expect(lstatSync(join(wt, 'apps/mobile/node_modules')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(wt, 'node_modules/a/index.js'), 'utf8')).toContain('module.exports')
    expect(git(wt, 'status', '--porcelain')).toBe('')
    expect(depsBriefLine(state)).toContain('own_dependencies')
    expect(await checkChildDeps(wt, state)).toEqual([])
  })

  it('reports an install through the link and a changed lockfile', async () => {
    const state = await prepareChildDeps(main, wt, await planChildDeps(main, base, 'link', 'darwin'))
    writeFileSync(join(wt, 'node_modules', '.package-lock.json'), '{"changed":true}')
    writeFileSync(join(wt, 'apps/mobile/package-lock.json'), '{"changed":true}')
    const problems = await checkChildDeps(wt, state)
    expect(problems).toEqual([
      'the packages in node_modules were installed or removed',
      'the lockfile next to apps/mobile/node_modules changed',
    ])
  })

  it('removes the worktree and leaves the main checkout node_modules intact', async () => {
    await prepareChildDeps(main, wt, await planChildDeps(main, base, 'link', 'darwin'))
    await removeWorktree(main, wt)
    expect(existsSync(wt)).toBe(false)
    expect(readFileSync(join(main, 'node_modules/a/index.js'), 'utf8')).toContain('module.exports')
    expect(readFileSync(join(main, 'apps/mobile/node_modules/a/index.js'), 'utf8')).toContain('module.exports')
  })

  it('does not link when the lockfile at the base differs from the main checkout', async () => {
    writeFileSync(join(main, 'package-lock.json'), JSON.stringify({ packages: { '': {}, 'node_modules/b': {} } }))
    const plans = await planChildDeps(main, base, 'link', 'darwin')
    expect(plans.find((p) => p.path === 'node_modules')?.mode).toBe('install')
    expect(plans.find((p) => p.path === 'apps/mobile/node_modules')?.mode).toBe('link')
  })

  it('never deletes a real folder to make room for a link', async () => {
    mkdirSync(join(wt, 'node_modules'))
    writeFileSync(join(wt, 'node_modules', 'mine.txt'), 'x')
    const state = await prepareChildDeps(main, wt, [{ path: 'node_modules', pkgDir: null, mode: 'link', reason: null }])
    expect(state.folders[0]?.mode).toBe('none')
    expect(readFileSync(join(wt, 'node_modules', 'mine.txt'), 'utf8')).toBe('x')
  })

  it('refuses a link whose parent resolves into the main checkout', async () => {
    mkdirSync(join(main, 'packages', 'p'), { recursive: true })
    mkdirSync(join(main, 'node_modules', '@s'))
    symlinkSync('../../packages/p', join(main, 'node_modules', '@s', 'p'))
    const state = await prepareChildDeps(main, wt, [
      { path: 'node_modules', pkgDir: '', mode: 'link', reason: null },
      { path: 'node_modules/@s/p', pkgDir: null, mode: 'link', reason: null },
    ])
    expect(state.folders.map((f) => f.mode)).toEqual(['link', 'none'])
    expect(readlinkSync(join(main, 'node_modules', '@s', 'p'))).toBe('../../packages/p')
  })

  it.runIf(process.platform === 'darwin')('own_dependencies swaps a link for a clone', async () => {
    const state = await prepareChildDeps(main, wt, await planChildDeps(main, base, 'link', 'darwin'))
    const owned = await ownChildDeps(main, wt, state)
    expect(owned.state.folders.map((f) => f.mode)).toEqual(['clone', 'clone'])
    expect(lstatSync(join(wt, 'node_modules')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(wt, 'node_modules/a/index.js'), 'utf8')).toContain('module.exports')
    expect(await readLinkManifest(wt)).toEqual([])
    writeFileSync(join(wt, 'node_modules/a/index.js'), 'changed')
    expect(readFileSync(join(main, 'node_modules/a/index.js'), 'utf8')).toContain('module.exports')
  })
})
