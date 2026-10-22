/**
 * The filesystem side of `shared/project-repos.ts`: the bounded child scan,
 * and resolving the `repoPath` an agent names to a work tree that is really
 * inside the chat's project folder.
 */
import { readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { scanChildWorkTrees, type ScanEntry } from '@shared/project-repos'
import { createMainLogger } from '../logger'
import { defaultGitRun, type GitRun } from './branch-check'

const log = createMainLogger('pull-requests:project-repos')

/** True for the folder itself and anything below it; never for `..` or another drive. */
export function isWithinFolder(folder: string, target: string): boolean {
  const rel = path.relative(folder, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/** "/"-separated, for messages; '.' for the folder itself. */
export function relativeLabel(folder: string, target: string): string {
  return path.relative(folder, target).split(path.sep).join('/') || '.'
}

/**
 * Work trees at most two levels below `projectPath`, as absolute paths. A
 * project at the home folder or a filesystem root is never scanned: listing
 * ~/Desktop, ~/Documents or ~/Downloads would raise a macOS privacy prompt,
 * and Reviews would fill with every checkout on the machine.
 */
export async function scanChildRepoDirs(projectPath: string): Promise<{ dirs: string[]; complete: boolean }> {
  const resolved = path.resolve(projectPath)
  if (resolved === path.resolve(homedir()) || resolved === path.parse(resolved).root)
    return { dirs: [], complete: true }
  let complete = true
  const listDir = async (rel: string): Promise<ScanEntry[]> => {
    const entries = await readdir(path.join(projectPath, ...rel.split('/').filter(Boolean)), { withFileTypes: true })
    return entries.map((e) => ({
      name: e.name,
      kind: e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
    }))
  }
  const found = await scanChildWorkTrees(listDir, (rel, err) => {
    complete = false
    log.debug('skipping an unreadable directory', { projectPath, rel, err: String(err) })
  })
  return { dirs: found.map((rel) => path.join(projectPath, ...rel.split('/'))), complete }
}

export interface RepoDirDeps {
  realpath(p: string): Promise<string>
  run: GitRun
}

const defaultRepoDirDeps: RepoDirDeps = { realpath: (p) => realpath(p), run: defaultGitRun }

export type RepoDir =
  | {
      ok: true
      dir: string
      /** Relative to the project folder; the absolute path for a worktree outside it. */
      relPath: string
      /** The main checkout of the repository `dir` belongs to, relative to the project folder ('.' for the folder itself). */
      mainRelPath: string
    }
  | { ok: false; message: string }

/**
 * `repoPath` (relative to the project folder, or absolute) as the real path
 * of a git work tree inside it, or of a linked worktree (for example one in
 * /tmp) of a repository whose main checkout is inside it. Every path is
 * resolved with realpath first, so neither `..` nor a symlink can point
 * outside the folder, and a worktree outside counts only when its main
 * checkout lists it in `git worktree list`.
 */
export async function resolveRepoDir(
  projectPath: string,
  repoPath: string,
  deps: RepoDirDeps = defaultRepoDirDeps,
): Promise<RepoDir> {
  let root: string
  let dir: string
  try {
    root = await deps.realpath(projectPath)
  } catch (err) {
    log.warn('resolving the project folder failed', { projectPath, err: String(err) })
    return { ok: false, message: `The project folder ${projectPath} cannot be read.` }
  }
  try {
    dir = await deps.realpath(path.resolve(root, repoPath))
  } catch (err) {
    log.debug('repoPath does not resolve', { repoPath, err: String(err) })
    return { ok: false, message: `repoPath "${repoPath}" does not exist under ${projectPath}.` }
  }
  const inside = isWithinFolder(root, dir)
  const main = await mainCheckoutOf(dir, deps)
  if (!inside && !(main && isWithinFolder(root, main))) {
    return {
      ok: false,
      message:
        `repoPath "${repoPath}" is outside this chat's project folder ${projectPath}, and it is not a git worktree of a repository inside it. ` +
        'Only a repository inside the folder, or a worktree of one, can be used.',
    }
  }
  const tree = await deps.run(dir, ['rev-parse', '--is-inside-work-tree'])
  if (tree.code !== 0 || tree.stdout.trim() !== 'true') {
    return { ok: false, message: `repoPath "${repoPath}" (${dir}) is not a git work tree.` }
  }
  // A folder inside a work tree stands for the work tree, so the card names the checkout.
  const top = await deps.run(dir, ['rev-parse', '--show-toplevel'])
  if (top.code === 0 && top.stdout.trim()) {
    try {
      const topDir = await deps.realpath(top.stdout.trim())
      if (inside ? isWithinFolder(root, topDir) : isWithinFolder(topDir, dir)) dir = topDir
    } catch (err) {
      log.debug('the work tree top level does not resolve', { dir, err: String(err) })
    }
  }
  const relPath = isWithinFolder(root, dir) ? relativeLabel(root, dir) : dir
  return {
    ok: true,
    dir,
    relPath,
    mainRelPath: main && isWithinFolder(root, main) ? relativeLabel(root, main) : relPath,
  }
}

/**
 * The real path of the main checkout of the repository `dir` is in: the
 * folder holding its common git directory. Null when that is not a `.git`
 * folder (a bare repository, a separate git dir), or when the main checkout
 * does not list a worktree holding `dir`, so a hand-made `.git` file pointing
 * at a repository is not taken for one of its worktrees.
 */
async function mainCheckoutOf(dir: string, deps: RepoDirDeps): Promise<string | null> {
  const common = await deps.run(dir, ['rev-parse', '--git-common-dir'])
  if (common.code !== 0 || !common.stdout.trim()) return null
  let commonDir: string
  try {
    commonDir = await deps.realpath(path.resolve(dir, common.stdout.trim()))
  } catch (err) {
    log.debug('the common git directory does not resolve', { dir, err: String(err) })
    return null
  }
  if (path.basename(commonDir) !== '.git') return null
  const main = path.dirname(commonDir)
  if (isWithinFolder(main, dir)) return main
  const listed = await deps.run(main, ['worktree', 'list', '--porcelain'])
  if (listed.code !== 0) return null
  for (const line of listed.stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue
    try {
      if (isWithinFolder(await deps.realpath(line.slice('worktree '.length)), dir)) return main
    } catch (err) {
      log.debug('a listed worktree does not resolve', { line, err: String(err) })
    }
  }
  return null
}
