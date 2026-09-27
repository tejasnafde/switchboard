/**
 * Bitbucket Cloud through REST API 2.0, with an Atlassian account email and
 * API token (HTTP Basic). Reads are GETs; the human write actions POST,
 * PUT or DELETE through `BitbucketClient.send`.
 *
 * The token lives only in the Authorization header of requests to
 * api.bitbucket.org. It is never logged, and a `next` page link on any other
 * origin is refused rather than followed with credentials attached.
 */
import type { InlineCommentInput, SubmitReviewInput } from '@shared/pull-request-writes'
import type {
  BitbucketCredentialInput,
  MergeStrategy,
  PrChangedFile,
  PrCheck,
  PrConversation,
  PrDetail,
  PrError,
  PrRef,
  PrReviewerCandidate,
  PrSummary,
  RepoRef,
  SourceControlTestResult,
} from '@shared/pull-requests'
import { prKey, repoKey } from '@shared/pull-requests'
import { createMainLogger } from '../logger'
import { VersionedCache } from './cache'
import {
  conflictedPaths,
  mapBbCandidates,
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
  type BbWorkspaceMember,
} from './bitbucket-map'
import { PrHostError, type PullRequestProvider, type RepoListResult } from './provider'

const log = createMainLogger('pull-requests:bitbucket')

export const BITBUCKET_API = 'https://api.bitbucket.org/2.0'
const REQUEST_TIMEOUT_MS = 20_000
const MAX_PAGES = 5
const MERGED_WINDOW_DAYS = 7
/** Running checks are re-read after this even when the PR has not changed. */
const PENDING_CHECKS_MAX_AGE_MS = 4 * 60_000
/** Repository admin rarely changes; re-read it at most this often. */
const ADMIN_TTL_MS = 10 * 60_000

export type FetchLike = (url: string, init: { method?: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
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

  private async request(url: string, accept: string, write?: { method: WriteMethod; body?: object }): Promise<Awaited<ReturnType<FetchLike>>> {
    if (!url.startsWith(`${BITBUCKET_API}/`)) {
      throw new PrHostError({ kind: 'unknown', host: 'bitbucket', message: 'Bitbucket pointed at another origin; not followed.' })
    }
    const headers = this.headers(accept)
    if (write?.body) headers['Content-Type'] = 'application/json'
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await this.fetchImpl(url, {
        method: write?.method ?? 'GET',
        headers,
        body: write?.body ? JSON.stringify(write.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      log.warn('Bitbucket request failed', { path: new URL(url).pathname, err: String(err) })
      throw new PrHostError({ kind: 'offline', host: 'bitbucket', message: 'Could not reach bitbucket.org.' })
    }
    if (res.ok) return res
    const path = new URL(url).pathname
    log.warn('Bitbucket answered with an error', { path, status: res.status, method: write?.method ?? 'GET' })
    if (write) throw new PrHostError(await bitbucketWriteError(res))
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

  /** A write. Returns the JSON answer, or `null` for an empty one (204). */
  async send<T = unknown>(method: WriteMethod, path: string, body?: object): Promise<{ status: number; data: T | null }> {
    const res = await this.request(`${BITBUCKET_API}${path}`, 'application/json', { method, body })
    const text = await res.text()
    if (!text.trim()) return { status: res.status, data: null }
    try {
      return { status: res.status, data: JSON.parse(text) as T }
    } catch (err) {
      log.warn('Bitbucket answered a write with text that is not JSON', { path, bytes: text.length, err: String(err) })
      return { status: res.status, data: null }
    }
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

type WriteMethod = 'POST' | 'PUT' | 'DELETE'

/** A refused write -> the typed error, with Bitbucket's own reason when it gave one. */
export async function bitbucketWriteError(res: { status: number; headers: { get(name: string): string | null }; text(): Promise<string> }): Promise<PrError> {
  let said = ''
  try {
    const body = JSON.parse(await res.text()) as { error?: { message?: string; detail?: string } }
    said = [body.error?.message, body.error?.detail].filter(Boolean).join(': ').slice(0, 300)
  } catch (err) {
    log.debug('Bitbucket error body is not JSON', { status: res.status, err: String(err) })
  }
  const err = (kind: PrError['kind'], fallback: string): PrError => ({ kind, host: 'bitbucket', message: said || fallback })
  switch (res.status) {
    case 400: return err('invalid', 'Bitbucket refused the input.')
    case 401: return { kind: 'token_rejected', host: 'bitbucket', message: 'Bitbucket rejected the email and API token.' }
    case 403: return err('forbidden', 'Bitbucket does not let this account do that. The API token needs the write pull requests scope.')
    case 404: return err('stale', 'Bitbucket could not find it; it may have been deleted.')
    case 409: return err('conflict', 'Bitbucket refused because of the pull request state.')
    case 429: {
      const retryAfter = Number(res.headers.get('retry-after'))
      return {
        kind: 'rate_limited',
        host: 'bitbucket',
        message: 'Bitbucket rate limit reached.',
        retryAt: Number.isFinite(retryAfter) && retryAfter > 0 ? Date.now() + retryAfter * 1000 : undefined,
      }
    }
  }
  return err('unknown', `Bitbucket answered ${res.status}.`)
}

/** Neutral -> Bitbucket strategy names. */
const BB_MERGE_STRATEGY: Record<MergeStrategy, string> = {
  merge_commit: 'merge_commit',
  squash: 'squash',
  rebase: 'rebase_fast_forward',
  fast_forward: 'fast_forward',
  squash_fast_forward: 'squash_fast_forward',
  rebase_merge: 'rebase_merge',
}

/** The comment body for a line: `to` anchors on the new side, `from` on the old one. */
export function bbInlineComment(c: InlineCommentInput): Record<string, unknown> {
  const inline: Record<string, unknown> = { path: c.path, [c.side === 'old' ? 'from' : 'to']: c.line }
  if (c.startLine !== undefined) inline[c.side === 'old' ? 'start_from' : 'start_to'] = c.startLine
  return { content: { raw: c.body }, inline }
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
  private readonly admin = new Map<string, { at: number; admin: boolean }>()

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

  /** The list cannot say whether a PR conflicts, so the list reads the diffstat too; the detail reads its own. */
  private async fetchEnrichment(ref: PrRef, pr: BbPullRequest, withConflicts: boolean): Promise<BbEnrichment> {
    const hash = pr.source.commit?.hash
    const [statuses, comments, diffstat] = await Promise.all([
      hash ? this.client.paged<BbStatus>(`${repoPath(ref)}/commit/${hash}/statuses?pagelen=100`, 1) : Promise.resolve([]),
      this.client.paged<BbComment>(`${prPath(ref)}/comments?pagelen=100`),
      withConflicts ? this.diffstat(ref) : Promise.resolve([]),
    ])
    return { checks: mapBbStatuses(statuses), unresolvedConversations: unresolvedCount(mapBbComments(comments)), conflictedFiles: conflictedPaths(diffstat) }
  }

  private diffstat(ref: PrRef): Promise<BbDiffstat[]> {
    return this.client.paged<BbDiffstat>(`${prPath(ref)}/diffstat?pagelen=500`)
  }

  /**
   * Checks, open conversations and conflicts for an open PR, re-read only
   * when the PR changed, its target branch moved (which is what makes a
   * conflict appear without the PR changing), or checks were still running.
   * The list asks at most as often as the refresh rule allows.
   */
  private async enrich(ref: PrRef, pr: BbPullRequest): Promise<BbEnrichment> {
    const key = prKey(ref)
    const version = `${pr.updated_on}|${pr.destination.commit?.hash ?? ''}`
    const cached = this.enrichment.get(key, version)
    if (cached) return cached
    const fresh = await this.fetchEnrichment(ref, pr, true)
    const running = fresh.checks.some((c) => c.state === 'pending')
    this.enrichment.set(key, version, fresh, running ? { maxAgeMs: PENDING_CHECKS_MAX_AGE_MS } : {})
    return fresh
  }

  /** Whether the account is admin on the repository, which Bitbucket asks for to decline or edit someone else's PR. */
  private async isRepoAdmin(repo: RepoRef): Promise<boolean> {
    const key = repoKey(repo)
    const hit = this.admin.get(key)
    if (hit && this.now() - hit.at < ADMIN_TTL_MS) return hit.admin
    let admin = false
    try {
      const q = encodeURIComponent(`repository.full_name="${repo.owner}/${repo.name}"`)
      const perms = await this.client.paged<{ permission?: string }>(`/user/permissions/repositories?q=${q}`, 1)
      admin = perms.some((p) => p.permission === 'admin')
    } catch (err) {
      if (!(err instanceof PrHostError)) throw err
      log.info('reading repository permission failed; treating as not admin', { repo: key, kind: err.error.kind })
    }
    this.admin.set(key, { at: this.now(), admin })
    return admin
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
    const [extra, diffstat, activity, admin] = await Promise.all([
      this.fetchEnrichment(ref, pr, false),
      this.diffstat(ref),
      this.client.paged<BbActivity>(`${prPath(ref)}/activity?pagelen=50`, 1),
      this.isRepoAdmin(ref),
    ])
    return mapBbDetail(ref, pr, viewer, extra, diffstat, activity, admin)
  }

  async files(ref: PrRef): Promise<PrChangedFile[]> {
    const [diffstat, diff] = await Promise.all([
      this.diffstat(ref),
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

  // ─── Writes ────────────────────────────────────────────────────

  async reply(ref: PrRef, conversationId: string, body: string): Promise<void> {
    await this.client.send('POST', `${prPath(ref)}/comments`, { content: { raw: body }, parent: { id: Number(conversationId) } })
  }

  /** A conversation's id is its root comment's, which is what Bitbucket resolves. */
  async setResolved(ref: PrRef, conversationId: string, resolved: boolean): Promise<void> {
    await this.client.send(resolved ? 'POST' : 'DELETE', `${prPath(ref)}/comments/${Number(conversationId)}/resolve`)
  }

  async comment(ref: PrRef, body: string): Promise<void> {
    await this.client.send('POST', `${prPath(ref)}/comments`, { content: { raw: body } })
  }

  async inlineComment(ref: PrRef, comment: InlineCommentInput): Promise<void> {
    await this.client.send('POST', `${prPath(ref)}/comments`, bbInlineComment(comment))
  }

  /**
   * Bitbucket has no review object: post the pending comments one by one,
   * the summary as a comment on the PR, then approve or request changes. A
   * failure part way says how many comments already went, so the client
   * drops those and a retry does not post them twice.
   */
  async submitReview(ref: PrRef, review: SubmitReviewInput): Promise<void> {
    let posted = 0
    try {
      for (const c of review.comments) {
        await this.inlineComment(ref, c)
        posted++
      }
      if (review.body) await this.comment(ref, review.body)
      if (review.event === 'approve') await this.client.send('POST', `${prPath(ref)}/approve`)
      if (review.event === 'request_changes') await this.client.send('POST', `${prPath(ref)}/request-changes`)
    } catch (err) {
      if (!(err instanceof PrHostError) || posted === 0) throw err
      log.warn('review failed part way', { number: ref.number, posted, of: review.comments.length })
      const message = `${err.error.message} ${posted} of ${review.comments.length} comments were posted before it stopped.`
      throw new PrHostError({ ...err.error, message, postedComments: posted })
    }
  }

  /**
   * Bitbucket merges have no expected-head guard, so the service's re-read
   * just before is the only one. A slow merge answers 202 and finishes on
   * the host; the refresh after it shows the result.
   */
  async merge(ref: PrRef, strategy: MergeStrategy): Promise<void> {
    const res = await this.client.send('POST', `${prPath(ref)}/merge`, { type: 'pullrequest', merge_strategy: BB_MERGE_STRATEGY[strategy] })
    if (res.status === 202) log.info('Bitbucket queued the merge', { number: ref.number })
  }

  async rerunCheck(): Promise<void> {
    throw new PrHostError({ kind: 'forbidden', host: 'bitbucket', message: "Bitbucket's API cannot re-run a pipeline." })
  }

  /** Workspace members; a token without the workspace read scope sees none, and the card still offers recent reviewers. */
  async reviewerCandidates(repo: RepoRef): Promise<PrReviewerCandidate[]> {
    try {
      return mapBbCandidates(await this.client.paged<BbWorkspaceMember>(`/workspaces/${encodeURIComponent(repo.owner)}/members?pagelen=100`))
    } catch (err) {
      if (!(err instanceof PrHostError) || err.error.kind === 'offline') throw err
      log.warn('listing workspace members failed', { workspace: repo.owner, kind: err.error.kind })
      return []
    }
  }

  /**
   * Bitbucket has no add-one-reviewer call: PUT the PR with the whole list.
   * The list is read just before, so a reviewer someone added in between
   * survives unless it lands between these two requests.
   */
  private async putReviewers(ref: PrRef, edit: (uuids: string[]) => string[]): Promise<void> {
    const pr = await this.client.json<BbPullRequest>(prPath(ref))
    const current = (pr.reviewers ?? []).map((u) => u.uuid).filter((u): u is string => !!u)
    await this.client.send('PUT', prPath(ref), bbReviewersBody(pr.title, edit(current)))
  }

  async addReviewer(ref: PrRef, reviewer: string): Promise<void> {
    await this.putReviewers(ref, (uuids) => (uuids.includes(reviewer) ? uuids : [...uuids, reviewer]))
  }

  async removeReviewer(ref: PrRef, reviewer: string): Promise<void> {
    await this.putReviewers(ref, (uuids) => uuids.filter((u) => u !== reviewer))
  }

  async decline(ref: PrRef): Promise<void> {
    await this.client.send('POST', `${prPath(ref)}/decline`)
  }
}

/** Bitbucket's PUT needs the title; fields left out (the description) are not touched. */
export function bbReviewersBody(title: string, uuids: readonly string[]): { title: string; reviewers: Array<{ uuid: string }> } {
  return { title, reviewers: uuids.map((uuid) => ({ uuid })) }
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
