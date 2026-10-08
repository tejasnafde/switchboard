/**
 * Which pull request host a git remote points at. Covers the https and ssh
 * forms git and both hosts hand out:
 *
 *   https://github.com/owner/repo(.git)
 *   https://user@bitbucket.org/workspace/repo.git
 *   git@github.com:owner/repo.git
 *   ssh://git@bitbucket.org/workspace/repo.git
 *   ssh://git@ssh.github.com:443/owner/repo.git
 */
import { repoKey, type PrHost, type RepoRef } from './pull-requests'

const HOSTS: Record<string, PrHost> = {
  'github.com': 'github',
  'www.github.com': 'github',
  'ssh.github.com': 'github',
  'bitbucket.org': 'bitbucket',
  'www.bitbucket.org': 'bitbucket',
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/

function toRef(hostName: string, path: string): RepoRef | null {
  const host = HOSTS[hostName.toLowerCase()]
  if (!host) return null
  const parts = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .split('/')
  if (parts.length !== 2) return null
  const [owner, name] = parts
  if (!SEGMENT.test(owner) || !SEGMENT.test(name) || name === '.' || name === '..') return null
  return { host, owner, name }
}

export function parseRemoteUrl(url: string): RepoRef | null {
  const trimmed = url.trim()
  // scp-like: [user@]host:path, with no scheme.
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(trimmed)
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return toRef(scp[1], scp[2])
  if (!URL.canParse(trimmed)) return null
  const parsed = new URL(trimmed)
  if (!['https:', 'http:', 'ssh:', 'git+ssh:', 'git:'].includes(parsed.protocol)) return null
  return toRef(parsed.hostname, parsed.pathname)
}

/**
 * Every repository a checkout's remotes point at, from `git remote -v`
 * output: `upstream` first (a fork's PRs are opened against upstream), then
 * `origin`, then the rest in order, each once.
 */
export function reposFromRemotes(remoteVerbose: string): RepoRef[] {
  const byName = new Map<string, RepoRef>()
  for (const line of remoteVerbose.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim())
    if (!m || m[3] !== 'fetch') continue
    const ref = parseRemoteUrl(m[2])
    if (ref && !byName.has(m[1])) byName.set(m[1], ref)
  }
  const ordered = [byName.get('upstream'), byName.get('origin'), ...byName.values()]
  const seen = new Set<string>()
  return ordered.filter((ref): ref is RepoRef => {
    if (!ref || seen.has(repoKey(ref))) return false
    seen.add(repoKey(ref))
    return true
  })
}

/** The repository a project's pull requests live in: the first of `reposFromRemotes`. */
export function repoFromRemotes(remoteVerbose: string): RepoRef | null {
  return reposFromRemotes(remoteVerbose)[0] ?? null
}

/** The remotes (by name, `git remote -v` order) whose fetch URL is `repo`. */
export function remotesForRepo(remoteVerbose: string, repo: RepoRef): string[] {
  const key = repoKey(repo)
  const names: string[] = []
  for (const line of remoteVerbose.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim())
    if (!m || m[3] !== 'fetch' || names.includes(m[1])) continue
    const ref = parseRemoteUrl(m[2])
    if (ref && repoKey(ref) === key) names.push(m[1])
  }
  return names
}

/** "owner/name" as the host's API names a repository, or null. */
export function parseFullName(host: PrHost, fullName: string): RepoRef | null {
  const [owner, name, ...rest] = fullName.trim().split('/')
  if (
    rest.length > 0 ||
    !owner ||
    !name ||
    !SEGMENT.test(owner) ||
    !SEGMENT.test(name) ||
    name === '.' ||
    name === '..'
  )
    return null
  return { host, owner, name }
}
