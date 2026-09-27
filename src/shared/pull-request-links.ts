/**
 * Links between a chat and the pull requests it works on. Stored by the
 * backend under the chat's root conversation (`resolveRootThreadId`), so a
 * provider session rotation keeps them.
 *
 * A link is made by hand (Reviews > Link to chat) or automatically, once,
 * when the chat's assistant text or tool output names a PR URL of the chat's
 * own project repository. A PR of another repository is never linked.
 */
import { prKey, repoKey, type PrHost, type PrRef, type PrSummary, type RepoRef } from './pull-requests'

export type PrLinkSource = 'manual' | 'auto'

export interface PrLink {
  ref: PrRef
  source: PrLinkSource
  linkedAt: number
}

/** A chat a PR is linked to, or could be linked to. */
export interface PrLinkChat {
  /** Root conversation id. */
  id: string
  /** Every id of the chat's thread (root plus rotated provider session ids), so a client finds the one it has open. */
  familyIds: string[]
  title: string
  agentType: string
  projectPath: string
  updatedAt: number
}

export type PrLinkResult = { ok: true } | { ok: false; message: string }

/** "Find linked PRs in this chat". `capped`: only the first `capChars` characters of the chat were read. */
export type PrHistoryScanResult =
  | { ok: true; linked: number; capped: boolean; capChars: number }
  | { ok: false; message: string }

/** What the manual scan tells the user. */
export function historyScanSummary(result: PrHistoryScanResult): { title: string; body?: string } {
  if (!result.ok) return { title: 'Could not scan this chat', body: result.message }
  const title = result.linked === 0
    ? 'No new pull requests found'
    : `Linked ${result.linked} pull request${result.linked === 1 ? '' : 's'}`
  const parts = ["Only pull requests of this chat's project repository are linked, and one you unlinked stays unlinked."]
  if (result.capped) parts.push(`This chat is long, so only its first ${result.capChars.toLocaleString('en-US')} characters were read.`)
  return { title, body: parts.join(' ') }
}

/** Owner and repository are case-insensitive on both hosts; links are stored lower case. */
export function normalizePrRef(ref: PrRef): PrRef {
  return { host: ref.host, owner: ref.owner.toLowerCase(), name: ref.name.toLowerCase(), number: ref.number }
}

export function isPrRef(value: unknown): value is PrRef {
  const r = value as Partial<PrRef> | null
  return !!r
    && (r.host === 'github' || r.host === 'bitbucket')
    && typeof r.owner === 'string' && /^[A-Za-z0-9_.-]+$/.test(r.owner)
    && typeof r.name === 'string' && /^[A-Za-z0-9_.-]+$/.test(r.name)
    && Number.isInteger(r.number) && (r.number as number) > 0
}

/** A chat may link only PRs of the repository its project points at. */
export function canLinkToProject(ref: PrRef, projectRepo: RepoRef | null): boolean {
  return projectRepo !== null && repoKey(ref) === repoKey(projectRepo)
}

// https://github.com/<owner>/<repo>/pull/<n>
// https://bitbucket.org/<workspace>/<repo>/pull-requests/<n>
// The number must end the path segment: `/pull/61` inside `/pull/612` never matches.
const PR_URL = /\bhttps?:\/\/(?:www\.)?(github\.com|bitbucket\.org)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(pull|pull-requests)\/(\d{1,9})(?!\w)/gi

const URL_HOST: Record<string, { host: PrHost; path: string }> = {
  'github.com': { host: 'github', path: 'pull' },
  'bitbucket.org': { host: 'bitbucket', path: 'pull-requests' },
}

/** Every distinct pull request URL in `text`, in first-seen order. */
export function findPullRequestUrls(text: string): PrRef[] {
  const out: PrRef[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(PR_URL)) {
    const site = URL_HOST[m[1].toLowerCase()]
    if (m[4].toLowerCase() !== site.path) continue
    const ref = normalizePrRef({ host: site.host, owner: m[2], name: m[3].replace(/\.git$/i, ''), number: Number(m[5]) })
    const key = prKey(ref)
    if (ref.number === 0 || seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}

/** The PR URLs in `text` a chat of a project on `projectRepo` should link. */
export function autoLinkRefs(text: string, projectRepo: RepoRef | null): PrRef[] {
  if (!projectRepo) return []
  return findPullRequestUrls(text).filter((ref) => canLinkToProject(ref, projectRepo))
}

/** What a chat header says about a linked PR: "build failed · 3 open conversations". */
export function linkedPrPhrase(pr: PrSummary): string {
  const parts: string[] = []
  if (pr.state !== 'open') parts.push(pr.state)
  else if (pr.checks.state === 'failure') parts.push('build failed')
  else if (pr.checks.state === 'pending') parts.push('checks running')
  const open = pr.unresolvedConversations ?? 0
  if (pr.state === 'open' && open > 0) parts.push(`${open} open conversation${open === 1 ? '' : 's'}`)
  return parts.join(' · ')
}
