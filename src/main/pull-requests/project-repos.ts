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
export async function scanChildRepoDirs(projectPath: string): Promise<string[]> {
  const resolved = path.resolve(projectPath)
  if (resolved === path.resolve(homedir()) || resolved === path.parse(resolved).root) return []
  const listDir = async (rel: string): Promise<ScanEntry[]> => {
    const entries = await readdir(path.join(projectPath, ...rel.split('/').filter(Boolean)), { withFileTypes: true })
    return entries.map((e) => ({
      name: e.name,
      kind: e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
    }))
  }
  const found = await scanChildWorkTrees(listDir, (rel, err) => {
    log.debug('skipping an unreadable directory', { projectPath, rel, err: String(err) })
  })
  return found.map((rel) => path.join(projectPath, ...rel.split('/')))
}

export interface RepoDirDeps {
  realpath(p: string): Promise<string>
  run: GitRun
}

const defaultRepoDirDeps: RepoDirDeps = { realpath: (p) => realpath(p), run: defaultGitRun }

export type RepoDir = { ok: true; dir: string; relPath: string } | { ok: false; message: string }

/**
 * `repoPath` (relative to the project folder, or absolute) as the real path
 * of a git work tree inside it. Both sides are resolved with realpath first,
 * so neither `..` nor a symlink can point outside the folder.
 */
export async function resolveRepoDir(projectPath: string, repoPath: string, deps: RepoDirDeps = defaultRepoDirDeps): Promise<RepoDir> {
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
  if (!isWithinFolder(root, dir)) {
    return { ok: false, message: `repoPath "${repoPath}" is outside this chat's project folder ${projectPath}; only a repository inside it can be used.` }
  }
  const tree = await deps.run(dir, ['rev-parse', '--is-inside-work-tree'])
  if (tree.code !== 0 || tree.stdout.trim() !== 'true') {
    return { ok: false, message: `repoPath "${repoPath}" (${dir}) is not a git work tree.` }
  }
  return { ok: true, dir, relPath: relativeLabel(root, dir) }
}
