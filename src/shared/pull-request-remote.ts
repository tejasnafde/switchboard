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
  const parts = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').split('/')
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
 * The repository a project's pull requests live in, from `git remote -v`
 * output. `upstream` wins over `origin` (a fork's PRs are opened against
 * upstream), then `origin`, then the first supported remote.
 */
export function repoFromRemotes(remoteVerbose: string): RepoRef | null {
  const byName = new Map<string, RepoRef>()
  for (const line of remoteVerbose.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim())
    if (!m || m[3] !== 'fetch') continue
    const ref = parseRemoteUrl(m[2])
    if (ref && !byName.has(m[1])) byName.set(m[1], ref)
  }
  return byName.get('upstream') ?? byName.get('origin') ?? byName.values().next().value ?? null
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
