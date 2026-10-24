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
import { addProject, getProjects } from '../../src/main/db/database'
import {
  cloneStatus,
  readCloneSource,
  readIgnoredFile,
  recoverInterruptedClones,
  resolveCloneTarget,
  startClone,
  writeIgnoredFile,
} from '../../src/main/ipc/project-clone'
import { CloneJournal, folderIdentity, removePartialClone } from '../../src/main/ipc/project-clone-journal'
import { INTERRUPTED_CLONE_MESSAGE, type CloneStatus } from '../../src/shared/project-clone'
import { forgetProjectFavicon, resolveProjectFavicon } from '../../src/main/projects/favicon-resolver'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    stdio: 'pipe',
  })
    .toString()
    .trim()

let root: string
let journal: CloneJournal

beforeEach(() => {
  createMigratedDb()
  root = mkdtempSync(join(tmpdir(), 'sb-clone-test-'))
  journal = new CloneJournal(join(root, 'data', 'project-clones.json'))
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

function deps(homeDir: string, onSettled?: (s: CloneStatus) => void) {
  return { homeDir, journal, onSettled }
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

    const home = join(root, 'target-home')
    const { done, onSettled } = settled()
    const started = await startClone(
      { url: info.url, remoteBranch: info.remoteBranch, name: 'demo' },
      deps(home, onSettled),
    )
    const dest = join(home, 'projects', 'demo')
    expect(started).toEqual({ ok: true, path: dest })
    // Listed at once, so a chat can be opened while the clone runs, and journaled for a restart.
    expect(getProjects().map((p) => p.path)).toContain(dest)
    expect((await journal.read()).map((e) => e.path)).toEqual([dest])
    expect((await writeIgnoredFile(dest, '.env', 'x')).ok).toBe(false)

    expect(await done).toEqual({ phase: 'done', branch: 'feat' })
    expect(cloneStatus(dest)).toEqual({ phase: 'done', branch: 'feat' })
    expect(await journal.read()).toEqual([])
    // Git on Windows may check out CRLF (core.autocrlf).
    expect(readFileSync(join(dest, 'feature.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('only on the fork\n')

    const read = await readIgnoredFile(source, '.env')
    if (!read.ok) throw new Error(read.error)
    expect(await writeIgnoredFile(dest, '.env', read.content)).toEqual({ ok: true })
    expect(readFileSync(join(dest, '.env'), 'utf8')).toBe('SECRET=1\n')
    if (process.platform !== 'win32') expect(lstatSync(join(dest, '.env')).mode & 0o777).toBe(0o600)
    // Never overwrites, never writes a tracked file.
    expect((await writeIgnoredFile(dest, '.env', 'other')).ok).toBe(false)
    expect((await writeIgnoredFile(dest, 'README.md2', 'x')).ok).toBe(false)

    const again = await startClone({ url: info.url, remoteBranch: 'feat', name: 'demo' }, deps(home))
    expect(again.ok).toBe(false)
  })

  it('clones the default branch when the branch was never pushed', async () => {
    const { source } = makeSource()
    git(source, 'checkout', '-b', 'local-only')
    const info = await readCloneSource(source)
    if (!info.ok) throw new Error(info.error)
    expect(info.remoteName).toBe('origin')
    const { done, onSettled } = settled()
    await startClone({ url: info.url, remoteBranch: info.remoteBranch, name: 'demo' }, deps(root, onSettled))
    expect(await done).toEqual({ phase: 'done', branch: 'main' })
  })

  it('refuses a project that is a folder inside a repository', async () => {
    const { source } = makeSource()
    mkdirSync(join(source, 'sub'))
    expect(await readCloneSource(join(source, 'sub'))).toMatchObject({ ok: false, reason: 'error' })
  })

  it('says so plainly when there is no remote', async () => {
    const source = join(root, 'plain')
    git(root, 'init', source)
    expect(await readCloneSource(source)).toMatchObject({ ok: false, reason: 'no-remote' })
  })

  it('removes the folder and the project row when the clone fails', async () => {
    const { done, onSettled } = settled()
    await startClone({ url: join(root, 'missing.git'), remoteBranch: null, name: 'gone' }, deps(root, onSettled))
    expect((await done).phase).toBe('failed')
    expect(getProjects().map((p) => p.path)).not.toContain(join(root, 'projects', 'gone'))
    expect(() => lstatSync(join(root, 'projects', 'gone'))).toThrow()
    expect(await journal.read()).toEqual([])
  })

  it('refuses unsafe requests before touching the disk', async () => {
    expect((await startClone({ url: 'ext::sh', remoteBranch: null, name: 'x' }, deps(root))).ok).toBe(false)
    expect((await startClone({ url: '/a', remoteBranch: null, name: '..' }, deps(root))).ok).toBe(false)
    expect((await startClone({ url: '/a', remoteBranch: '-x', name: 'y' }, deps(root))).ok).toBe(false)
    for (const path of ['~/-x', 'rel/dir', '~/a/../b', '/tmp/a\nb', '~/', '/']) {
      expect((await startClone({ url: '/a', remoteBranch: null, name: 'y', path }, deps(root))).ok).toBe(false)
    }
    expect(() => lstatSync(join(root, 'projects'))).toThrow()
    expect(await journal.read()).toEqual([])
  })
})

// Targets are SSH machines, and a Windows path is refused (`cloneTargetPathProblem`).
describe.skipIf(process.platform === 'win32')('the target folder', () => {
  it('expands ~/ against the home folder and defaults to ~/projects/<name>', () => {
    expect(resolveCloneTarget({ name: 'app' }, '/home/u')).toEqual({ ok: true, path: '/home/u/projects/app' })
    expect(resolveCloneTarget({ name: 'app', path: '~/code/app' }, '/home/u')).toEqual({
      ok: true,
      path: '/home/u/code/app',
    })
    expect(resolveCloneTarget({ name: 'app', path: '/srv//app/' }, '/home/u')).toEqual({ ok: true, path: '/srv/app' })
    // The home folder itself, reached by an absolute path, is refused.
    expect(resolveCloneTarget({ name: 'app', path: '/home/u' }, '/home/u').ok).toBe(false)
  })

  it('clones into a chosen folder, and into an existing empty folder', async () => {
    const { source } = makeSource()
    const info = await readCloneSource(source)
    if (!info.ok) throw new Error(info.error)
    const home = join(root, 'home')
    const first = settled()
    const started = await startClone(
      { url: info.url, remoteBranch: info.remoteBranch, name: 'demo', path: '~/code/demo' },
      deps(home, first.onSettled),
    )
    expect(started).toEqual({ ok: true, path: join(home, 'code', 'demo') })
    expect(await first.done).toMatchObject({ phase: 'done' })
    expect(getProjects().find((p) => p.path === join(home, 'code', 'demo'))?.name).toBe('demo')

    const empty = join(root, 'empty-target')
    mkdirSync(empty)
    const second = settled()
    expect(
      await startClone(
        { url: info.url, remoteBranch: info.remoteBranch, name: 'x', path: empty },
        deps(home, second.onSettled),
      ),
    ).toEqual({ ok: true, path: empty })
    expect(await second.done).toMatchObject({ phase: 'done' })
    expect(readFileSync(join(empty, 'README.md'), 'utf8').replace(/\r\n/g, '\n')).toBe('# demo\n')
    // Two real clones; slow on a loaded machine.
  }, 20_000)

  it('refuses an existing folder that is not empty, and leaves it alone', async () => {
    const full = join(root, 'full')
    mkdirSync(full)
    writeFileSync(join(full, 'mine.txt'), 'keep')
    const result = await startClone({ url: '/a', remoteBranch: null, name: 'x', path: full }, deps(root))
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('not empty') })
    expect(readFileSync(join(full, 'mine.txt'), 'utf8')).toBe('keep')
    expect(await journal.read()).toEqual([])
  })

  it('refuses a second clone into the same folder while the first runs', async () => {
    const empty = join(root, 'shared-target')
    mkdirSync(empty)
    const { done, onSettled } = settled()
    const request = { url: join(root, 'missing.git'), remoteBranch: null, name: 'x', path: empty }
    const [first, second] = await Promise.all([
      startClone(request, deps(root, onSettled)),
      startClone(request, deps(root)),
    ])
    expect(first.ok).toBe(true)
    expect(second).toMatchObject({ ok: false, error: expect.stringContaining('already running') })
    await done
  })

  it('empties, but keeps, an existing folder when the clone fails', async () => {
    const empty = join(root, 'was-empty')
    mkdirSync(empty)
    const { done, onSettled } = settled()
    await startClone(
      { url: join(root, 'missing.git'), remoteBranch: null, name: 'x', path: empty },
      deps(root, onSettled),
    )
    expect((await done).phase).toBe('failed')
    expect(lstatSync(empty).isDirectory()).toBe(true)
  })
})

describe('a clone cut off by a restart', () => {
  /** What a backend leaves when it dies mid-clone: the folder, some of git's files, the row and the journal entry. */
  async function leaveHalfClone(name: string, opts: { createdFolder: boolean }) {
    const dest = join(root, 'projects', name)
    mkdirSync(join(dest, '.git', 'objects'), { recursive: true })
    writeFileSync(join(dest, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    addProject(dest, name)
    const entry = { path: dest, ...(await folderIdentity(dest)), ...opts, addedProject: true }
    await journal.add(entry)
    return { dest, entry }
  }

  it('removes the folder and the project row it made, and reads as failed', async () => {
    const { dest } = await leaveHalfClone('half', { createdFolder: true })
    expect(cloneStatus(dest)).toEqual({ phase: 'unknown' })
    await recoverInterruptedClones(journal)
    expect(() => lstatSync(dest)).toThrow()
    expect(getProjects().map((p) => p.path)).not.toContain(dest)
    expect(cloneStatus(dest)).toEqual({ phase: 'failed', error: INTERRUPTED_CLONE_MESSAGE })
    expect(await journal.read()).toEqual([])
  })

  it('only empties a folder that was there before the clone', async () => {
    const { dest } = await leaveHalfClone('pre', { createdFolder: false })
    await recoverInterruptedClones(journal)
    expect(lstatSync(dest).isDirectory()).toBe(true)
    expect(() => lstatSync(join(dest, '.git'))).toThrow()
  })

  it('never removes a folder that took the place of the one it made', async () => {
    const { dest } = await leaveHalfClone('replaced', { createdFolder: true })
    rmSync(dest, { recursive: true })
    mkdirSync(dest)
    writeFileSync(join(dest, 'user.txt'), 'mine')
    await recoverInterruptedClones(journal)
    expect(readFileSync(join(dest, 'user.txt'), 'utf8')).toBe('mine')
    // The row points at the user's folder now, so it stays.
    expect(getProjects().map((p) => p.path)).toContain(dest)
    expect(cloneStatus(dest)).toMatchObject({ phase: 'failed' })
    expect(await journal.read()).toEqual([])
  })

  it('never follows a link that took the place of the folder', async () => {
    if (process.platform === 'win32') return
    const { dest, entry } = await leaveHalfClone('linked', { createdFolder: true })
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'keep.txt'), 'keep')
    rmSync(dest, { recursive: true })
    symlinkSync(elsewhere, dest)
    expect(await removePartialClone(entry)).toBe('not-ours')
    expect(readFileSync(join(elsewhere, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('leaves a folder with the same device and inode but another birth time', async () => {
    const { dest, entry } = await leaveHalfClone('reborn', { createdFolder: true })
    expect(await removePartialClone({ ...entry, birth: String(BigInt(entry.birth) + 1n) })).toBe('not-ours')
    expect(readFileSync(join(dest, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n')
  })

  it('refuses a journal path that is not absolute and normal, or is the home folder', async () => {
    const base = { dev: '1', ino: '1', birth: '1', createdFolder: true, addedProject: false }
    expect(await removePartialClone({ ...base, path: 'relative/x' })).toBe('not-ours')
    expect(await removePartialClone({ ...base, path: `${root}/a/../b` })).toBe('not-ours')
    expect(await removePartialClone({ ...base, path: '/' })).toBe('not-ours')
  })

  it('reads a missing or corrupt journal as empty', async () => {
    expect(await journal.read()).toEqual([])
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(join(root, 'data', 'project-clones.json'), '{not json')
    expect(await journal.read()).toEqual([])
    await recoverInterruptedClones(journal)
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
