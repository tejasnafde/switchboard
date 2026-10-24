/**
 * Dependency folders a worktree shares with its main checkout through a
 * symlink (`<worktree>/<path>` -> `<main>/<path>`), used by child chats.
 *
 * Three files keep a link safe:
 *   - the repository's shared `info/exclude` lists each path with no trailing
 *     slash. A `.gitignore` line such as `apps/mobile/node_modules/` applies
 *     only to a real folder, so without this the link shows as untracked: the
 *     worktree reads "has changes" and an agent's `git add -A` commits it.
 *   - `switchboard-dep-links.json` in the worktree's own git folder lists the
 *     links, so `removeDependencyLinks` can unlink them before git removes the
 *     worktree, with no database read. Git removes that folder with the
 *     worktree.
 *   - nothing else: a real file or folder is never deleted to make room, and
 *     only an existing symlink is replaced.
 *
 * Only the filesystem is read here (the `.git` file, `commondir`), never the
 * git CLI, so a removal of a worktree that is already gone costs nothing.
 */
import { appendFile, lstat, mkdir, readFile, readlink, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { createMainLogger } from '../logger'

const log = createMainLogger('git:dependency-links')

const MANIFEST = 'switchboard-dep-links.json'
const EXCLUDE_HEADER = '# Switchboard: dependency folders linked into worktrees'

/** The worktree's own git folder, from its `.git` file, or null for a main checkout or no checkout. */
async function worktreeGitDir(worktree: string): Promise<string | null> {
  let text: string
  try {
    text = await readFile(join(worktree, '.git'), 'utf8')
  } catch (err) {
    // A main checkout has a `.git` folder (EISDIR); a removed worktree has none.
    log.debug(`no worktree .git file in ${worktree}: ${(err as NodeJS.ErrnoException).code}`)
    return null
  }
  const m = /^gitdir:\s*(.+)$/m.exec(text)
  if (!m) return null
  const dir = m[1]!.trim()
  return isAbsolute(dir) ? dir : resolve(worktree, dir)
}

/** The repository's shared git folder (`git rev-parse --git-common-dir`). */
async function commonGitDir(gitDir: string): Promise<string> {
  try {
    const rel = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim()
    return isAbsolute(rel) ? rel : resolve(gitDir, rel)
  } catch (err) {
    log.debug(`no commondir in ${gitDir}: ${(err as NodeJS.ErrnoException).code}`)
    return gitDir
  }
}

export async function readLinkManifest(worktree: string): Promise<string[]> {
  const gitDir = await worktreeGitDir(worktree)
  if (!gitDir) return []
  try {
    const parsed: unknown = JSON.parse(await readFile(join(gitDir, MANIFEST), 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`could not read ${MANIFEST} of ${worktree}`, err)
    return []
  }
}

async function writeLinkManifest(worktree: string, paths: string[]): Promise<void> {
  const gitDir = await worktreeGitDir(worktree)
  if (!gitDir) throw new Error(`${worktree} is not a linked worktree`)
  await writeFile(join(gitDir, MANIFEST), JSON.stringify([...new Set(paths)].sort()))
}

/** Adds `/<path>` to the shared `info/exclude` for each path it does not list yet. */
async function excludeLinks(worktree: string, paths: string[]): Promise<void> {
  const gitDir = await worktreeGitDir(worktree)
  if (!gitDir) throw new Error(`${worktree} is not a linked worktree`)
  const file = join(await commonGitDir(gitDir), 'info', 'exclude')
  let current = ''
  try {
    current = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    await mkdir(dirname(file), { recursive: true })
  }
  const have = new Set(current.split('\n').map((l) => l.trim()))
  const missing = paths.map((p) => `/${p}`).filter((line) => !have.has(line))
  if (missing.length === 0) return
  const head = have.has(EXCLUDE_HEADER) ? [] : [EXCLUDE_HEADER]
  const lead = current === '' || current.endsWith('\n') ? '' : '\n'
  await appendFile(file, `${lead}${[...head, ...missing].join('\n')}\n`)
}

export type LinkResult = { ok: true; target: string } | { ok: false; reason: string }

/**
 * Links `<worktree>/<path>` to `<main>/<path>`, then records it in
 * `info/exclude` and the manifest. Refuses a worktree that is the main
 * checkout itself and a path that holds a real file or folder.
 */
export async function linkDependencyFolder(main: string, worktree: string, path: string): Promise<LinkResult> {
  const target = join(main, path)
  const at = join(worktree, path)
  if (resolve(worktree) === resolve(main)) return { ok: false, reason: 'the worktree is the main checkout' }
  try {
    const existing = await lstat(at).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    if (existing && !existing.isSymbolicLink()) return { ok: false, reason: 'the worktree already has this folder' }
    // Recorded before the link exists, so a removal after a crash here still unlinks it.
    await writeLinkManifest(worktree, [...(await readLinkManifest(worktree)), path])
    await excludeLinks(worktree, [path])
    if (existing) await unlink(at)
    await mkdir(dirname(at), { recursive: true })
    await symlink(target, at, 'dir')
    return { ok: true, target }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log.warn(`could not link ${path} into ${worktree}: ${reason}`)
    return { ok: false, reason }
  }
}

/** The link's target, or null when `<worktree>/<path>` is no longer a symlink. */
export async function linkTarget(worktree: string, path: string): Promise<string | null> {
  try {
    return await readlink(join(worktree, path))
  } catch (err) {
    log.debug(`${path} in ${worktree} is not a link: ${(err as NodeJS.ErrnoException).code}`)
    return null
  }
}

/** Drops `path` from the manifest, after the link was replaced by the worktree's own folder. */
export async function forgetDependencyLink(worktree: string, path: string): Promise<void> {
  await writeLinkManifest(
    worktree,
    (await readLinkManifest(worktree)).filter((p) => p !== path),
  )
}

/**
 * Unlinks every dependency link of `worktree` (only symlinks; a path that is a
 * real folder now is left alone). Called before `git worktree remove`, so git
 * never walks into the main checkout's folders. Never throws.
 */
export async function removeDependencyLinks(worktree: string): Promise<number> {
  let removed = 0
  for (const path of await readLinkManifest(worktree)) {
    const at = resolve(worktree, path)
    if (!at.startsWith(resolve(worktree) + sep)) continue
    try {
      if ((await lstat(at)).isSymbolicLink()) {
        await unlink(at)
        removed++
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`could not unlink ${at}`, err)
    }
  }
  if (removed > 0) log.info(`removed ${removed} dependency link(s) from ${worktree}`)
  return removed
}
