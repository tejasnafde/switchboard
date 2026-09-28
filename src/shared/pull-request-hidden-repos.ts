/**
 * Repositories the list could not read, grouped for one Reviews card per
 * host and reason, and the rules for hiding a repository from Reviews. A
 * hidden repository is not read at all, so a workspace the account cannot
 * see stops costing a 404 on every refresh. Local only: nothing reaches a host.
 */
import { repoKey, type PrError, type PrHost, type PrSource, type RepoRef } from './pull-requests'

/** The two reasons a repository keeps failing until the user does something about it. Rate limits and network errors pass on their own. */
export type HideableRepoErrorKind = 'not_found' | 'forbidden'

export function isHideableRepoError(error: PrError | null): error is PrError & { kind: HideableRepoErrorKind } {
  return error?.kind === 'not_found' || error?.kind === 'forbidden'
}

export interface RepoFailureGroup {
  host: PrHost
  kind: HideableRepoErrorKind
  /** First-seen order; each owner (GitHub owner, Bitbucket workspace) once. */
  owners: Array<{ owner: string; names: string[] }>
  repos: RepoRef[]
}

/** One group per host and reason, however many repositories and owners share it. */
export function groupRepoFailures(sources: readonly PrSource[]): RepoFailureGroup[] {
  const groups = new Map<string, RepoFailureGroup>()
  const seen = new Set<string>()
  for (const source of sources) {
    if (!isHideableRepoError(source.error)) continue
    const key = repoKey(source.repo)
    if (seen.has(key)) continue
    seen.add(key)
    const id = `${source.repo.host}:${source.error.kind}`
    const group = groups.get(id) ?? { host: source.repo.host, kind: source.error.kind, owners: [], repos: [] }
    const owner = group.owners.find((o) => o.owner.toLowerCase() === source.repo.owner.toLowerCase())
    if (owner) owner.names.push(source.repo.name)
    else group.owners.push({ owner: source.repo.owner, names: [source.repo.name] })
    group.repos.push(source.repo)
    groups.set(id, group)
  }
  return [...groups.values()]
}

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/
/** One hide call; a client cannot fill the table in one go. */
export const MAX_REPOS_PER_HIDE = 200

export function isRepoRef(value: unknown): value is RepoRef {
  const r = value as Partial<RepoRef> | null
  return !!r
    && (r.host === 'github' || r.host === 'bitbucket')
    && typeof r.owner === 'string' && SEGMENT.test(r.owner)
    && typeof r.name === 'string' && SEGMENT.test(r.name)
}

/** The `repos` argument of hide / unhide, or `null` when it is not a non-empty list of repositories. */
export function parseRepoRefs(value: unknown): RepoRef[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REPOS_PER_HIDE) return null
  if (!value.every(isRepoRef)) return null
  return value.map((r) => ({ host: r.host, owner: r.owner, name: r.name }))
}
