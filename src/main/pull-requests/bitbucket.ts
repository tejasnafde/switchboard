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
import { BITBUCKET_READ_SCOPES, prKey, repoKey } from '@shared/pull-requests'
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
  type BbFileConflict,
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
/** Repository permission rarely changes; re-read it at most this often. */
const PERMISSION_TTL_MS = 10 * 60_000
const BB_REJECTED = 'Bitbucket rejected the email and API token.'
const BB_MISSING_SCOPE = `The API token is missing a scope this needs (${BITBUCKET_READ_SCOPES.join(', ')}).`

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
    if (res.status === 401) throw new PrHostError({ kind: 'token_rejected', host: 'bitbucket', message: BB_REJECTED })
    if (res.status === 403) throw new PrHostError({ kind: 'token_rejected', host: 'bitbucket', message: BB_MISSING_SCOPE })
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
    case 401: return { kind: 'token_rejected', host: 'bitbucket', message: BB_REJECTED }
    case 403: return err('forbidden', 'Bitbucket does not let this account do that. The API token needs the write:pullrequest:bitbucket scope.')
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
  private readonly permission = new Map<string, { at: number; write: boolean }>()

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

  /** The list cannot say whether a PR conflicts, so it reads the conflicts with the checks and comments. */
  private async fetchEnrichment(ref: PrRef, pr: BbPullRequest): Promise<BbEnrichment> {
    const hash = pr.source.commit?.hash
    const [statuses, comments, conflictedFiles] = await Promise.all([
      hash ? this.client.paged<BbStatus>(`${repoPath(ref)}/commit/${hash}/statuses?pagelen=100`, 1) : Promise.resolve([]),
      this.client.paged<BbComment>(`${prPath(ref)}/comments?pagelen=100`),
      pr.state === 'OPEN' ? this.conflicts(ref) : Promise.resolve([]),
    ])
    return { checks: mapBbStatuses(statuses), unresolvedConversations: unresolvedCount(mapBbComments(comments)), conflictedFiles }
  }

  /**
   * `GET /pullrequests/{id}/conflicts` (read:pullrequest, redirecting to the
   * repository's file-conflicts). The diffstat's old "merge conflict" status
   * came from the merge preview Atlassian removed on 2026-09-04. `null` when
   * the read fails for anything but the account or the network, so one
   * unreadable answer blanks the conflict state instead of the whole list.
   */
  private async conflicts(ref: PrRef): Promise<string[] | null> {
    try {
      return conflictedPaths(await this.client.paged<BbFileConflict>(`${prPath(ref)}/conflicts?pagelen=100`))
    } catch (err) {
      if (!(err instanceof PrHostError) || err.error.kind === 'token_rejected' || err.error.kind === 'offline') throw err
      log.warn('reading pull request conflicts failed', { number: ref.number, kind: err.error.kind })
      return null
    }
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
    const fresh = await this.fetchEnrichment(ref, pr)
    const running = fresh.checks.some((c) => c.state === 'pending')
    this.enrichment.set(key, version, fresh, running ? { maxAgeMs: PENDING_CHECKS_MAX_AGE_MS } : {})
    return fresh
  }

  /**
   * Whether the account can write to the repository, which Bitbucket asks for
   * to decline or edit someone else's pull request. Read from
   * `/user/workspaces/{workspace}/permissions/repositories` (API token,
   * read:repository:bitbucket). `/user/permissions/repositories` was removed
   * by Atlassian and is never called. A refused or unreadable permission means
   * "not as far as we can tell": the controls stay hidden, and a write the
   * host refuses anyway comes back as its 403.
   */
  private async canWriteRepo(repo: RepoRef): Promise<boolean> {
    const key = repoKey(repo)
    const hit = this.permission.get(key)
    if (hit && this.now() - hit.at < PERMISSION_TTL_MS) return hit.write
    const fullName = `${repo.owner}/${repo.name}`.toLowerCase()
    let write = false
    try {
      const q = encodeURIComponent(`repository.full_name="${repo.owner}/${repo.name}"`)
      const perms = await this.client.paged<{ permission?: string; repository?: { full_name?: string } }>(
        `/user/workspaces/${encodeURIComponent(repo.owner)}/permissions/repositories?q=${q}`, 1)
      write = perms.some((p) => p.repository?.full_name?.toLowerCase() === fullName && (p.permission === 'write' || p.permission === 'admin'))
    } catch (err) {
      if (!(err instanceof PrHostError)) throw err
      log.info('reading repository permission failed; treating as no write access', { repo: key, kind: err.error.kind })
    }
    this.permission.set(key, { at: this.now(), write })
    return write
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
    const [extra, diffstat, activity, canWrite] = await Promise.all([
      this.fetchEnrichment(ref, pr),
      this.diffstat(ref),
      this.client.paged<BbActivity>(`${prPath(ref)}/activity?pagelen=50`, 1),
      this.canWriteRepo(ref),
    ])
    return mapBbDetail(ref, pr, viewer, extra, diffstat, activity, canWrite)
  }

  async files(ref: PrRef): Promise<PrChangedFile[]> {
    const [diffstat, diff, conflicted] = await Promise.all([
      this.diffstat(ref),
      this.client.text(`${prPath(ref)}/diff`),
      this.conflicts(ref),
    ])
    return mapBbFiles(diffstat, diff, conflicted ?? [])
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

/** Repositories checked by one Test, and how many at once. */
const TEST_MAX_REPOS = 50
const TEST_CONCURRENCY = 4

/**
 * Settings > Source control > Test. `/user` proves the credentials, then each
 * Bitbucket repository the projects point at gets one repository read and one
 * pull request list read, which is what Reviews needs. (Atlassian removed
 * `/user/permissions/repositories`, the cross-workspace listing this used to
 * call.) Bitbucket cannot check a write scope without writing, so writes are
 * not tested here. One fact per line; Settings renders the line breaks.
 */
export async function testBitbucket(client: BitbucketClient, repos: RepoRef[]): Promise<SourceControlTestResult> {
  let who = 'Signed in.'
  try {
    const user = await client.json<{ display_name?: string }>('/user')
    if (user.display_name) who = `Signed in as ${user.display_name}.`
  } catch (err) {
    if (err instanceof PrHostError) {
      log.warn('Bitbucket test failed', { kind: err.error.kind })
      const message = err.error.message === BB_MISSING_SCOPE ? 'The API token is missing the read:user:bitbucket scope.' : err.error.message
      return { ok: false, message }
    }
    log.error('Bitbucket test failed unexpectedly', err)
    return { ok: false, message: 'The test failed; see the log.' }
  }
  const checked = repos.slice(0, TEST_MAX_REPOS)
  if (checked.length === 0) return { ok: true, message: `${who}\nNone of your projects uses a Bitbucket repository yet.` }

  const failures: Array<{ owner: string; repo: string; step: 'repository' | 'pullrequests'; error: PrError | null }> = []
  const queue = [...checked]
  await Promise.all(Array.from({ length: Math.min(TEST_CONCURRENCY, queue.length) }, async () => {
    for (let repo = queue.shift(); repo; repo = queue.shift()) {
      let step: 'repository' | 'pullrequests' = 'repository'
      try {
        await client.json(`${repoPath(repo)}?fields=full_name`)
        step = 'pullrequests'
        await client.json(`${repoPath(repo)}/pullrequests?pagelen=1&fields=size`)
      } catch (err) {
        if (err instanceof PrHostError) log.warn('Bitbucket repository check failed', { repo: `${repo.owner}/${repo.name}`, step, kind: err.error.kind })
        else log.error('Bitbucket repository check failed unexpectedly', err)
        failures.push({ owner: repo.owner, repo: repo.name, step, error: err instanceof PrHostError ? err.error : null })
      }
    }
  }))
  const works = checked.length - failures.length
  const lines = [who]
  if (works === checked.length) lines.push(checked.length === 1 ? 'Your project repository is readable.' : `All ${checked.length} project repositories are readable.`)
  else {
    lines.push(works > 0 ? `${works} of ${checked.length} project repositories are readable.` : checked.length === 1 ? 'Your project repository is not readable.' : `None of your ${checked.length} project repositories is readable.`)
    const byOwner = new Map<string, string[]>()
    // The repository read worked but its pull requests did not: say so, the fix differs.
    for (const f of failures) byOwner.set(f.owner, [...(byOwner.get(f.owner) ?? []), f.step === 'pullrequests' ? `${f.repo} (pull requests)` : f.repo])
    for (const [owner, names] of [...byOwner].sort(([a], [b]) => a.localeCompare(b))) lines.push(`Cannot read in ${owner}: ${names.sort().join(', ')}`)
  }
  const missing = (step: 'repository' | 'pullrequests') => failures.some((f) => f.step === step && f.error?.message === BB_MISSING_SCOPE)
  if (missing('repository')) lines.push('The API token may be missing read:repository:bitbucket.')
  if (missing('pullrequests')) lines.push('The API token may be missing read:pullrequest:bitbucket.')
  if (failures.some((f) => f.error?.kind === 'offline')) lines.push('Some checks could not reach bitbucket.org.')
  if (failures.some((f) => f.error?.kind === 'rate_limited')) lines.push('Bitbucket rate-limited some checks. Try again in a minute.')
  if (repos.length > checked.length) lines.push(`Checked the first ${checked.length} of ${repos.length}.`)
  const message = lines.join('\n')
  return { ok: works > 0, message }
}
