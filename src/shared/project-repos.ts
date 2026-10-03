/**
 * Which repositories a project covers: the one rule behind every "only the
 * chat's own project's repository" check (Reviews, chat <-> PR links, the
 * agent PR tools).
 *
 * A project covers the repository its folder's git remotes point at. A folder
 * that points at no GitHub or Bitbucket repository (often not a repository at
 * all, but a parent of several) covers instead the repositories of the git
 * work trees at most two levels below it. A project that is a repository never
 * covers what is nested inside it (submodules, vendored checkouts), so Reviews
 * and the links of an ordinary project are unchanged.
 *
 * Pure: the directory listing and the remote reads are injected.
 */
import { repoKey, type RepoRef } from './pull-requests'

/** A git work tree under a project folder, and the repository its remotes point at. */
export interface ChildRepo {
  /** Absolute path, as the scan produced it. */
  path: string
  /** Relative to the project folder, "/"-separated, for messages and the card. */
  relPath: string
  repo: RepoRef
}

export interface ProjectRepos {
  own: RepoRef | null
  /** Empty whenever `own` is set. */
  children: ChildRepo[]
}

export const CHILD_REPO_MAX_DEPTH = 2
/** Directories listed per scan, so a project at a huge folder (a home directory) stays cheap. */
export const CHILD_REPO_MAX_LISTED_DIRS = 400
export const CHILD_REPO_MAX_FOUND = 64
const SKIPPED_DIRS = new Set(['node_modules'])

export function coveredRepos(project: ProjectRepos | null): RepoRef[] {
  if (!project) return []
  if (project.own) return [project.own]
  const seen = new Set<string>()
  return project.children.map((c) => c.repo).filter((repo) => {
    const key = repoKey(repo)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function projectCoversRepo(project: ProjectRepos | null, repo: RepoRef): boolean {
  const key = repoKey(repo)
  return coveredRepos(project).some((r) => repoKey(r) === key)
}

/** "owner/name (relPath)" per child, for a refusal that lists the candidates. */
export function describeChildRepos(children: readonly ChildRepo[]): string {
  return children.map((c) => `${c.repo.owner}/${c.repo.name} (${c.relPath})`).join(', ')
}

export type ChildRepoMatch =
  | { kind: 'one'; child: ChildRepo }
  | { kind: 'none'; candidates: ChildRepo[] }
  | { kind: 'many'; matches: ChildRepo[] }

/**
 * The one child work tree whose remote is one of `repos` (an "owner/name"
 * the agent sent may mean either host). Two checkouts are ambiguous, not a pick.
 */
export function findChildRepo(project: ProjectRepos, repos: readonly RepoRef[]): ChildRepoMatch {
  const keys = new Set(repos.map(repoKey))
  const matches = project.children.filter((c) => keys.has(repoKey(c.repo)))
  if (matches.length === 1) return { kind: 'one', child: matches[0] }
  return matches.length === 0 ? { kind: 'none', candidates: project.children } : { kind: 'many', matches }
}

export interface ScanEntry {
  name: string
  /** Symlinks report `symlink` and are never followed, so a scan cannot leave the project folder. */
  kind: 'dir' | 'file' | 'symlink' | 'other'
}

/**
 * The work trees (a directory holding `.git`, a directory or a worktree's
 * file) at most `CHILD_REPO_MAX_DEPTH` levels below the root, as "/"-joined
 * relative paths. Does not descend into a work tree it found, nor into
 * hidden directories or node_modules. `listDir` gets a relative path ('' for
 * the root) and may throw; an unreadable directory is skipped.
 */
export async function scanChildWorkTrees(
  listDir: (relPath: string) => Promise<ScanEntry[]>,
  onError: (relPath: string, err: unknown) => void = () => {},
): Promise<string[]> {
  const found: string[] = []
  const queue: { rel: string; depth: number }[] = [{ rel: '', depth: 0 }]
  let listed = 0
  for (let next = queue.shift(); next; next = queue.shift()) {
    if (listed >= CHILD_REPO_MAX_LISTED_DIRS || found.length >= CHILD_REPO_MAX_FOUND) break
    listed++
    let entries: ScanEntry[]
    try {
      entries = await listDir(next.rel)
    } catch (err) {
      onError(next.rel, err)
      continue
    }
    if (next.rel && entries.some((e) => e.name === '.git' && (e.kind === 'dir' || e.kind === 'file'))) {
      found.push(next.rel)
      continue
    }
    if (next.depth === CHILD_REPO_MAX_DEPTH) continue
    const subdirs = entries
      .filter((e) => e.kind === 'dir' && !e.name.startsWith('.') && !SKIPPED_DIRS.has(e.name))
      .map((e) => e.name)
      .sort()
    for (const name of subdirs) queue.push({ rel: next.rel ? `${next.rel}/${name}` : name, depth: next.depth + 1 })
  }
  return found
}

/** The rule itself: a project's own repository wins, and only a folder without one covers its children. */
export function projectReposFrom(own: RepoRef | null, children: readonly ChildRepo[]): ProjectRepos {
  return own ? { own, children: [] } : { own: null, children: [...children] }
}
