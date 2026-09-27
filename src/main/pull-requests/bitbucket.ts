/**
 * Bitbucket Cloud through REST API 2.0, with an Atlassian account email and
 * API token (HTTP Basic). Read-only: every request here is a GET.
 *
 * The token lives only in the Authorization header of requests to
 * api.bitbucket.org. It is never logged, and a `next` page link on any other
 * origin is refused rather than followed with credentials attached.
 */
import type {
  BitbucketCredentialInput,
  PrChangedFile,
  PrCheck,
  PrConversation,
  PrDetail,
  PrRef,
  PrSummary,
  RepoRef,
  SourceControlTestResult,
} from '@shared/pull-requests'
import { prKey } from '@shared/pull-requests'
import { createMainLogger } from '../logger'
import { VersionedCache } from './cache'
import {
  mapBbComments,
  mapBbDetail,
  mapBbFiles,
  mapBbStatuses,
  mapBbSummary,
  unresolvedCount,
  type BbActivity,
  type BbComment,
  type BbDiffstat,
  type BbEnrichment,
  type BbPullRequest,
  type BbStatus,
  type BbViewer,
} from './bitbucket-map'
import { PrHostError, type PullRequestProvider, type RepoListResult } from './provider'

const log = createMainLogger('pull-requests:bitbucket')

export const BITBUCKET_API = 'https://api.bitbucket.org/2.0'
const REQUEST_TIMEOUT_MS = 20_000
const MAX_PAGES = 5
const MERGED_WINDOW_DAYS = 7
/** Running checks are re-read after this even when the PR has not changed. */
const PENDING_CHECKS_MAX_AGE_MS = 4 * 60_000

type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  text(): Promise<string>
}>

interface Paged<T> {
  values: T[]
  next?: string
}

export class BitbucketClient {
  constructor(
    private readonly creds: BitbucketCredentialInput,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  private headers(accept: string): Record<string, string> {
    const basic = Buffer.from(`${this.creds.email}:${this.creds.apiToken}`).toString('base64')
    return { Authorization: `Basic ${basic}`, Accept: accept }
  }

  private async request(url: string, accept: string): Promise<Awaited<ReturnType<FetchLike>>> {
    if (!url.startsWith(`${BITBUCKET_API}/`)) {
      throw new PrHostError({ kind: 'unknown', host: 'bitbucket', message: 'Bitbucket pointed at another origin; not followed.' })
    }
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await this.fetchImpl(url, { headers: this.headers(accept), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (err) {
      log.warn('Bitbucket request failed', { path: new URL(url).pathname, err: String(err) })
      throw new PrHostError({ kind: 'offline', host: 'bitbucket', message: 'Could not reach bitbucket.org.' })
    }
    if (res.ok) return res
    const path = new URL(url).pathname
    log.warn('Bitbucket answered with an error', { path, status: res.status })
    if (res.status === 401) throw new PrHostError({ kind: 'token_rejected', host: 'bitbucket', message: 'Bitbucket rejected the email and API token.' })
    if (res.status === 403) throw new PrHostError({ kind: 'token_rejected', host: 'bitbucket', message: 'The API token is missing a scope this needs (read pull requests, read pipelines).' })
    if (res.status === 404) throw new PrHostError({ kind: 'not_found', host: 'bitbucket', message: 'Bitbucket could not find it, or this account cannot see it.' })
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'))
      throw new PrHostError({
        kind: 'rate_limited',
        host: 'bitbucket',
        message: 'Bitbucket rate limit reached.',
        retryAt: Number.isFinite(retryAfter) && retryAfter > 0 ? Date.now() + retryAfter * 1000 : undefined,
      })
    }
    throw new PrHostError({ kind: 'unknown', host: 'bitbucket', message: `Bitbucket answered ${res.status}.` })
  }

  async json<T>(path: string): Promise<T> {
    const res = await this.request(`${BITBUCKET_API}${path}`, 'application/json')
    return (await res.json()) as T
  }

  async text(path: string): Promise<string> {
    const res = await this.request(`${BITBUCKET_API}${path}`, 'text/plain')
    return res.text()
  }

  async paged<T>(path: string, maxPages = MAX_PAGES): Promise<T[]> {
    const out: T[] = []
    let url: string | undefined = `${BITBUCKET_API}${path}`
    for (let page = 0; url && page < maxPages; page++) {
      const res = await this.request(url, 'application/json')
      const body = (await res.json()) as Paged<T>
      out.push(...(body.values ?? []))
      url = body.next
    }
    return out
  }
}

function repoPath(repo: RepoRef): string {
  return `/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
}

function prPath(ref: PrRef): string {
  return `${repoPath(ref)}/pullrequests/${ref.number}`
}

const LIST_FIELDS = encodeURIComponent('+values.participants,+values.reviewers,+values.description')

export class BitbucketProvider implements PullRequestProvider {
  readonly host = 'bitbucket' as const
  private viewer: BbViewer | null = null
  private readonly enrichment = new VersionedCache<BbEnrichment>()

  constructor(
    private readonly client: BitbucketClient,
    private readonly now: () => number = Date.now,
  ) {}

  private async currentUser(): Promise<BbViewer> {
    if (!this.viewer) {
      const user = await this.client.json<{ uuid?: string; account_id?: string }>('/user')
      this.viewer = { uuid: user.uuid ?? null, accountId: user.account_id ?? null }
    }
    return this.viewer
  }

  private async fetchEnrichment(ref: PrRef, pr: BbPullRequest): Promise<BbEnrichment> {
    const hash = pr.source.commit?.hash
    const [statuses, comments] = await Promise.all([
      hash ? this.client.paged<BbStatus>(`${repoPath(ref)}/commit/${hash}/statuses?pagelen=100`, 1) : Promise.resolve([]),
      this.client.paged<BbComment>(`${prPath(ref)}/comments?pagelen=100`),
    ])
    return { checks: mapBbStatuses(statuses), unresolvedConversations: unresolvedCount(mapBbComments(comments)) }
  }

  /** Checks and open conversations for an open PR, re-read only when the PR changed or checks were still running. */
  private async enrich(ref: PrRef, pr: BbPullRequest): Promise<BbEnrichment> {
    const key = prKey(ref)
    const cached = this.enrichment.get(key, pr.updated_on)
    if (cached) return cached
    const fresh = await this.fetchEnrichment(ref, pr)
    const running = fresh.checks.some((c) => c.state === 'pending')
    this.enrichment.set(key, pr.updated_on, fresh, running ? { maxAgeMs: PENDING_CHECKS_MAX_AGE_MS } : {})
    return fresh
  }

  private involved(pr: BbPullRequest, viewer: BbViewer): boolean {
    const is = (u?: { uuid?: string; account_id?: string }) =>
      !!u && ((!!viewer.uuid && u.uuid === viewer.uuid) || (!!viewer.accountId && u.account_id === viewer.accountId))
    return is(pr.author) || (pr.reviewers ?? []).some(is) || (pr.participants ?? []).some((p) => is(p.user))
  }

  async list(repos: RepoRef[]): Promise<RepoListResult[]> {
    const viewer = await this.currentUser()
    const since = new Date(this.now() - MERGED_WINDOW_DAYS * 86_400_000).toISOString()
    const mergedQuery = encodeURIComponent(`state="MERGED" AND updated_on >= ${since}`)
    return Promise.all(repos.map(async (repo): Promise<RepoListResult> => {
      try {
        const [open, merged] = await Promise.all([
          this.client.paged<BbPullRequest>(`${repoPath(repo)}/pullrequests?state=OPEN&pagelen=50&fields=${LIST_FIELDS}`, 2),
          this.client.paged<BbPullRequest>(`${repoPath(repo)}/pullrequests?state=MERGED&q=${mergedQuery}&pagelen=50&fields=${LIST_FIELDS}`, 1),
        ])
        const mine = [...open, ...merged].filter((pr) => this.involved(pr, viewer))
        const prs: PrSummary[] = await Promise.all(mine.map(async (pr) => {
          const ref = { ...repo, number: pr.id }
          const extra = pr.state === 'OPEN' ? await this.enrich(ref, pr) : null
          return mapBbSummary(repo, pr, viewer, extra)
        }))
        return { repo, prs, error: null }
      } catch (err) {
        if (!(err instanceof PrHostError)) throw err
        // A bad token fails every repo the same way; let the service say it once.
        if (err.error.kind === 'token_rejected' || err.error.kind === 'offline') throw err
        log.warn('listing one repository failed', { repo: `${repo.owner}/${repo.name}`, kind: err.error.kind })
        return { repo, prs: [], error: err.error }
      }
    }))
  }

  async detail(ref: PrRef): Promise<PrDetail> {
    const viewer = await this.currentUser()
    const pr = await this.client.json<BbPullRequest>(prPath(ref))
    const [extra, diffstat, activity] = await Promise.all([
      this.fetchEnrichment(ref, pr),
      this.client.paged<BbDiffstat>(`${prPath(ref)}/diffstat?pagelen=500`),
      this.client.paged<BbActivity>(`${prPath(ref)}/activity?pagelen=50`, 1),
    ])
    return mapBbDetail(ref, pr, viewer, extra, diffstat, activity)
  }

  async files(ref: PrRef): Promise<PrChangedFile[]> {
    const [diffstat, diff] = await Promise.all([
      this.client.paged<BbDiffstat>(`${prPath(ref)}/diffstat?pagelen=500`),
      this.client.text(`${prPath(ref)}/diff`),
    ])
    return mapBbFiles(diffstat, diff)
  }

  async conversations(ref: PrRef): Promise<PrConversation[]> {
    return mapBbComments(await this.client.paged<BbComment>(`${prPath(ref)}/comments?pagelen=100`))
  }

  async checks(ref: PrRef): Promise<PrCheck[]> {
    const pr = await this.client.json<BbPullRequest>(prPath(ref))
    const hash = pr.source.commit?.hash
    if (!hash) return []
    return mapBbStatuses(await this.client.paged<BbStatus>(`${repoPath(ref)}/commit/${hash}/statuses?pagelen=100`, 1))
  }
}

/** Settings > Source control > Test: one read, reporting what the account can see. */
export async function testBitbucket(client: BitbucketClient): Promise<SourceControlTestResult> {
  try {
    const user = await client.json<{ display_name?: string }>('/user')
    const perms = await client.paged<{ repository?: { full_name?: string } }>('/user/permissions/repositories?pagelen=100', 3)
    const counts = new Map<string, number>()
    for (const p of perms) {
      const workspace = p.repository?.full_name?.split('/')[0]
      if (workspace) counts.set(workspace, (counts.get(workspace) ?? 0) + 1)
    }
    const workspaces = [...counts].map(([name, repositories]) => ({ name, repositories })).sort((a, b) => b.repositories - a.repositories)
    const total = perms.length
    const who = user.display_name ? `Signed in as ${user.display_name}. ` : ''
    const message = total === 0
      ? `${who}The token works but sees no repositories.`
      : `${who}Works for ${total} ${total === 1 ? 'repository' : 'repositories'} in ${workspaces.map((w) => w.name).join(', ')}.`
    return { ok: true, message, workspaces }
  } catch (err) {
    if (err instanceof PrHostError) {
      log.warn('Bitbucket test failed', { kind: err.error.kind })
      return { ok: false, message: err.error.message }
    }
    log.error('Bitbucket test failed unexpectedly', err)
    return { ok: false, message: 'The test failed; see the log.' }
  }
}
