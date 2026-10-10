/**
 * Links between a chat and the pull requests it works on. Stored by the
 * backend under the chat's root conversation (`resolveRootThreadId`), so a
 * provider session rotation keeps them.
 *
 * A link is made by hand (Reviews > Link to chat), by an agent
 * (`link_pull_request`, or `create_pull_request` for a PR it opened), or
 * automatically, once, when the chat's assistant text, a tool's input or its
 * output names a PR URL (or a bbpr command a PR number), or the chat's branch
 * has an open PR, on a repository the chat's project covers
 * (`project-repos.ts`). A PR of any other repository is never linked.
 */
import { prKey, type PrHost, type PrRef, type PrState, type PrSummary } from './pull-requests'
import { coveredRepos, projectCoversRepo, type ProjectRepos } from './project-repos'

/** How a link was made. `created`: the agent opened the PR; `agent`: it linked an existing one. */
export type PrLinkSource = 'manual' | 'auto' | 'agent' | 'created'

export const PR_LINK_SOURCE_LABEL: Record<PrLinkSource, string> = {
  manual: 'Linked by you',
  auto: 'Linked automatically',
  agent: 'Linked by the agent',
  created: 'Opened by the agent',
}

/** A source a newer backend may send reads as a plain "Linked". */
export function linkSourceLabel(source: string | undefined): string {
  return PR_LINK_SOURCE_LABEL[source as PrLinkSource] ?? 'Linked'
}

export interface PrLink {
  ref: PrRef
  source: PrLinkSource
  linkedAt: number
  /** The PR's state when the backend last read it (a merge in a shell, a sync at turn end); absent from older backends. */
  state?: PrState | null
  stateAt?: number | null
}

/**
 * The state a chat header shows: the stored link state when it was read after
 * the Reviews list (a merge the list has not seen yet), else the list's.
 */
export function linkHeaderState(
  link: Pick<PrLink, 'state' | 'stateAt'>,
  listState: PrState | null,
  listFetchedAt: number | null,
): PrState | null {
  if (link.state && (listState === null || (link.stateAt ?? 0) > (listFetchedAt ?? 0))) return link.state
  return listState ?? link.state ?? null
}

/**
 * One line for a phone's link list: "#612 · merged · Opened by the agent ·
 * owner/name". The repository goes last, so a long name is what a one-line
 * row cuts off, never the state or source. Ported to Android as `PrLinkRows.text`.
 */
export function phoneLinkRowText(link: Pick<PrLink, 'ref' | 'source' | 'state'>): string {
  const parts = [`#${link.ref.number}`]
  if (link.state && link.state !== 'open') parts.push(link.state)
  parts.push(linkSourceLabel(link.source), `${link.ref.owner}/${link.ref.name}`)
  return parts.join(' · ')
}

/** Accessible name of a link's Unlink button. It names the repository, since two repositories can share a number. */
export function unlinkPrLabel(ref: PrRef): string {
  return `Unlink pull request ${ref.owner}/${ref.name} #${ref.number}`
}

/** A shell command that merges or closes a PR, after which the chat's links re-read their state. */
export function mergesOrClosesPr(command: string): boolean {
  return /(?:^|[\s;&|(])(?:gh\s+pr\s+(?:merge|close)|bbpr\s+(?:merge|decline))\b/.test(command)
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
  /** How this chat's link to the PR was made (`linked-chats` only). */
  linkSource?: PrLinkSource
}

export type PrLinkResult = { ok: true } | { ok: false; message: string }

/** "Find linked PRs in this chat". `capped`: only the first `capChars` characters of the chat were read. */
export type PrHistoryScanResult =
  | { ok: true; linked: number; capped: boolean; capChars: number }
  | { ok: false; message: string }

/** What the manual scan tells the user. */
export function historyScanSummary(result: PrHistoryScanResult): { title: string; body?: string } {
  if (!result.ok) return { title: 'Could not scan this chat', body: result.message }
  const title =
    result.linked === 0
      ? 'No new pull requests found'
      : `Linked ${result.linked} pull request${result.linked === 1 ? '' : 's'}`
  const parts = [
    "Only pull requests of this chat's project repository are linked, and one you unlinked stays unlinked.",
  ]
  if (result.capped)
    parts.push(`This chat is long, so only its first ${result.capChars.toLocaleString('en-US')} characters were read.`)
  return { title, body: parts.join(' ') }
}

/** Owner and repository are case-insensitive on both hosts; links are stored lower case. */
export function normalizePrRef(ref: PrRef): PrRef {
  return { host: ref.host, owner: ref.owner.toLowerCase(), name: ref.name.toLowerCase(), number: ref.number }
}

export function isPrRef(value: unknown): value is PrRef {
  const r = value as Partial<PrRef> | null
  return (
    !!r &&
    (r.host === 'github' || r.host === 'bitbucket') &&
    typeof r.owner === 'string' &&
    /^[A-Za-z0-9_.-]+$/.test(r.owner) &&
    typeof r.name === 'string' &&
    /^[A-Za-z0-9_.-]+$/.test(r.name) &&
    Number.isInteger(r.number) &&
    (r.number as number) > 0
  )
}

/** A chat may link only PRs of a repository its project covers. */
export function canLinkToProject(ref: PrRef, project: ProjectRepos | null): boolean {
  return projectCoversRepo(project, ref)
}

// https://github.com/<owner>/<repo>/pull/<n>
// https://bitbucket.org/<workspace>/<repo>/pull-requests/<n>
// The number must end the path segment: `/pull/61` inside `/pull/612` never matches.
const PR_URL =
  /\bhttps?:\/\/(?:www\.)?(github\.com|bitbucket\.org)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(pull|pull-requests)\/(\d{1,9})(?!\w)/gi

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
    const ref = normalizePrRef({
      host: site.host,
      owner: m[2],
      name: m[3].replace(/\.git$/i, ''),
      number: Number(m[5]),
    })
    const key = prKey(ref)
    if (ref.number === 0 || seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}

/** The PR URLs in `text` a chat of `project` should link. */
export function autoLinkRefs(text: string, project: ProjectRepos | null): PrRef[] {
  if (coveredRepos(project).length === 0) return []
  return findPullRequestUrls(text).filter((ref) => canLinkToProject(ref, project))
}

/**
 * The PRs a chat of `project` should link: the URLs in `text`, plus the
 * numbers a `bbpr <n>` command named, which bbpr resolves against the current
 * git remote, the project's own (Bitbucket only; a parent folder's child
 * repositories link by URL).
 */
export function projectPrRefs(text: string, bbprNumbers: readonly number[], project: ProjectRepos | null): PrRef[] {
  const refs = autoLinkRefs(text, project)
  const projectRepo = project?.own ?? null
  if (projectRepo?.host !== 'bitbucket') return refs
  for (const number of bbprNumbers) {
    if (!refs.some((ref) => ref.number === number)) refs.push(normalizePrRef({ ...projectRepo, number }))
  }
  return refs
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
