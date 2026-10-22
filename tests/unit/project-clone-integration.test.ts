import { createMigratedDb } from './helpers/test-db'
import { execFileSync } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getProjects } from '../../src/main/db/database'
import {
  cloneStatus,
  readCloneSource,
  readIgnoredFile,
  startClone,
  writeIgnoredFile,
} from '../../src/main/ipc/project-clone'
import type { CloneStatus } from '../../src/shared/project-clone'
import { forgetProjectFavicon, resolveProjectFavicon } from '../../src/main/projects/favicon-resolver'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    stdio: 'pipe',
  })
    .toString()
    .trim()

let root: string

beforeEach(() => {
  createMigratedDb()
  root = mkdtempSync(join(tmpdir(), 'sb-clone-test-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A bare "upstream", a bare "fork", and a source checkout on `feat` that tracks the fork. */
function makeSource(): { source: string; fork: string } {
  const upstream = join(root, 'upstream.git')
  const fork = join(root, 'fork.git')
  const source = join(root, 'source')
  git(root, 'init', '--bare', upstream)
  git(root, 'init', '--bare', fork)
  git(root, 'init', source)
  writeFileSync(join(source, '.gitignore'), '.env\nnode_modules/\nbig.txt\nbin.dat\nlink\n')
  writeFileSync(join(source, 'README.md'), '# demo\n')
  git(source, 'add', '.')
  git(source, 'commit', '-m', 'init')
  git(source, 'remote', 'add', 'origin', upstream)
  git(source, 'remote', 'add', 'fork', fork)
  git(source, 'push', 'origin', 'main')
  git(source, 'checkout', '-b', 'feat')
  writeFileSync(join(source, 'feature.txt'), 'only on the fork\n')
  git(source, 'add', '.')
  git(source, 'commit', '-m', 'feat')
  git(source, 'push', '-u', 'fork', 'feat')
  writeFileSync(join(source, '.env'), 'SECRET=1\n')
  mkdirSync(join(source, 'node_modules'))
  writeFileSync(join(source, 'node_modules', 'x.js'), 'x')
  writeFileSync(join(source, 'big.txt'), 'a'.repeat(1024 * 1024 + 1))
  writeFileSync(join(source, 'bin.dat'), Buffer.from([1, 0, 2]))
  if (process.platform !== 'win32') symlinkSync(join(source, '.env'), join(source, 'link'))
  return { source, fork }
}

function settled(): { done: Promise<CloneStatus>; onSettled: (s: CloneStatus) => void } {
  let onSettled!: (s: CloneStatus) => void
  const done = new Promise<CloneStatus>((resolve) => (onSettled = resolve))
  return { done, onSettled }
}

describe('open a project on another machine (local bare repos)', () => {
  it('clones the fork the branch tracks, checks out that branch, and copies only the picked text file', async () => {
    const { source, fork } = makeSource()
    const info = await readCloneSource(source)
    if (!info.ok) throw new Error(info.error)
    expect(info).toMatchObject({ remoteName: 'fork', url: fork, branch: 'feat', remoteBranch: 'feat' })
    expect(info.ignored).toEqual([{ path: '.env', size: 9 }])
    expect(info.skippedIgnored).toBe(process.platform === 'win32' ? 3 : 4)

    expect((await readIgnoredFile(source, 'big.txt')).ok).toBe(false)
    expect((await readIgnoredFile(source, 'link')).ok).toBe(false)
    expect((await readIgnoredFile(source, 'README.md')).ok).toBe(false)
    expect((await readIgnoredFile(source, '../outside')).ok).toBe(false)

    const projectsDir = join(root, 'target-projects')
    const { done, onSettled } = settled()
    const started = await startClone(
      { url: info.url, remoteBranch: info.remoteBranch, name: 'demo' },
      { projectsDir, onSettled },
    )
    expect(started).toEqual({ ok: true, path: join(projectsDir, 'demo') })
    const dest = join(projectsDir, 'demo')
    // Listed at once, so a chat can be opened while the clone runs.
    expect(getProjects().map((p) => p.path)).toContain(dest)
    expect((await writeIgnoredFile(dest, '.env', 'x')).ok).toBe(false)

    expect(await done).toEqual({ phase: 'done', branch: 'feat' })
    expect(cloneStatus(dest)).toEqual({ phase: 'done', branch: 'feat' })
    expect(readFileSync(join(dest, 'feature.txt'), 'utf8')).toBe('only on the fork\n')

    const read = await readIgnoredFile(source, '.env')
    if (!read.ok) throw new Error(read.error)
    expect(await writeIgnoredFile(dest, '.env', read.content)).toEqual({ ok: true })
    expect(readFileSync(join(dest, '.env'), 'utf8')).toBe('SECRET=1\n')
    if (process.platform !== 'win32') expect(lstatSync(join(dest, '.env')).mode & 0o777).toBe(0o600)
    // Never overwrites, never writes a tracked file.
    expect((await writeIgnoredFile(dest, '.env', 'other')).ok).toBe(false)
    expect((await writeIgnoredFile(dest, 'README.md2', 'x')).ok).toBe(false)

    const again = await startClone({ url: info.url, remoteBranch: 'feat', name: 'demo' }, { projectsDir })
    expect(again.ok).toBe(false)
  })

  it('clones the default branch when the branch was never pushed', async () => {
    const { source } = makeSource()
    git(source, 'checkout', '-b', 'local-only')
    const info = await readCloneSource(source)
    if (!info.ok) throw new Error(info.error)
    expect(info.remoteName).toBe('origin')
    const { done, onSettled } = settled()
    await startClone({ url: info.url, remoteBranch: info.remoteBranch, name: 'demo' }, { projectsDir: root, onSettled })
    expect(await done).toEqual({ phase: 'done', branch: 'main' })
  })

  it('says so plainly when there is no remote', async () => {
    const source = join(root, 'plain')
    git(root, 'init', source)
    expect(await readCloneSource(source)).toMatchObject({ ok: false, reason: 'no-remote' })
  })

  it('removes the folder and the project row when the clone fails', async () => {
    const projectsDir = join(root, 'p')
    const { done, onSettled } = settled()
    await startClone({ url: join(root, 'missing.git'), remoteBranch: null, name: 'gone' }, { projectsDir, onSettled })
    expect((await done).phase).toBe('failed')
    expect(getProjects().map((p) => p.path)).not.toContain(join(projectsDir, 'gone'))
    expect(() => lstatSync(join(projectsDir, 'gone'))).toThrow()
  })

  it('refuses unsafe requests before touching the disk', async () => {
    expect((await startClone({ url: 'ext::sh', remoteBranch: null, name: 'x' }, { projectsDir: root })).ok).toBe(false)
    expect((await startClone({ url: '/a', remoteBranch: null, name: '..' }, { projectsDir: root })).ok).toBe(false)
    expect((await startClone({ url: '/a', remoteBranch: '-x', name: 'y' }, { projectsDir: root })).ok).toBe(false)
  })
})

describe('favicon cache after a clone', () => {
  it('forgets a cached "no favicon" for the path', async () => {
    const dir = join(root, 'empty')
    mkdirSync(dir)
    // A fixed folder mtime, so only forgetting the entry lets the new icon through.
    utimesSync(dir, 1000, 1000)
    expect(await resolveProjectFavicon(dir)).toBeNull()
    writeFileSync(join(dir, 'favicon.svg'), '<svg/>')
    utimesSync(dir, 1000, 1000)
    expect(await resolveProjectFavicon(dir)).toBeNull()
    forgetProjectFavicon(dir)
    expect((await resolveProjectFavicon(dir))?.absPath).toBe(join(dir, 'favicon.svg'))
  })
})
