/**
 * GitHub GraphQL / REST JSON -> neutral pull request types. Pure; the
 * queries that produce this JSON live beside the types in `github.ts`.
 */
import { orderMergeStrategies } from '@shared/pull-request-writes'
import {
  mergeBlockers,
  rollupChecks,
  stripHtmlComments,
  type ChangedFileStatus,
  type CheckState,
  type MergeStrategy,
  type PrActivity,
  type PrChangedFile,
  type PrCheck,
  type PrConversation,
  type PrDetail,
  type PrError,
  type PrPerson,
  type PrReviewer,
  type PrReviewerCandidate,
  type PrSummary,
  type RepoRef,
  type ReviewState,
} from '@shared/pull-requests'
import { parseHunks } from '@shared/unified-diff'
import { createMainLogger } from '../logger'
import { parseTime } from './provider'

const log = createMainLogger('pull-requests:github-map')

export interface GhActor {
  login: string
  name?: string | null
  avatarUrl?: string | null
}

export interface GhCheckRun {
  __typename: 'CheckRun'
  name: string
  status: string
  conclusion: string | null
  startedAt: string | null
  completedAt: string | null
  detailsUrl: string | null
}

export interface GhStatusContext {
  __typename: 'StatusContext'
  context: string
  state: string
  targetUrl: string | null
  description: string | null
  createdAt: string | null
}

export type GhCheckContext = GhCheckRun | GhStatusContext

export interface GhPullRequest {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  createdAt: string
  updatedAt: string
  mergedAt: string | null
  headRefName: string
  baseRefName: string
  headRefOid?: string | null
  additions?: number | null
  deletions?: number | null
  changedFiles?: number | null
  author: GhActor | null
  baseRef?: { branchProtectionRule: { requiredApprovingReviewCount: number | null } | null } | null
  reviewRequests?: { nodes: Array<{ requestedReviewer: ({ __typename: string; slug?: string } & Partial<GhActor>) | null }> }
  latestReviews?: { nodes: Array<{ state: string; author: GhActor | null; submittedAt?: string | null }> }
  reviewThreads?: { totalCount: number; nodes: Array<{ isResolved: boolean }> }
  commits?: { nodes: Array<{ commit: { statusCheckRollup: { state: string; contexts: { nodes: GhCheckContext[] } } | null } }> }
  /** GitHub works it out in the background after a push: `UNKNOWN` until it has. */
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
}

export interface GhTimelineItem {
  __typename: string
  state?: string
  submittedAt?: string | null
  createdAt?: string | null
  body?: string
  author?: GhActor | null
  actor?: GhActor | null
  comments?: { totalCount: number }
  commit?: { oid: string; committedDate: string; messageHeadline: string; author?: { user: GhActor | null } | null }
}

export interface GhPullRequestDetail extends GhPullRequest {
  body: string
  timelineItems?: { nodes: GhTimelineItem[] }
}

/** Repository merge settings, read beside the pull request. */
export interface GhRepoMergeSettings {
  mergeCommitAllowed?: boolean | null
  squashMergeAllowed?: boolean | null
  rebaseMergeAllowed?: boolean | null
  viewerPermission?: 'ADMIN' | 'MAINTAIN' | 'WRITE' | 'TRIAGE' | 'READ' | null
}

export interface GhReviewThread {
  id: string
  isResolved: boolean
  isOutdated: boolean
  path: string
  line: number | null
  originalLine: number | null
  diffSide: 'LEFT' | 'RIGHT'
  /** Set on a multi-line thread. */
  startLine?: number | null
  startDiffSide?: 'LEFT' | 'RIGHT' | null
  comments: { nodes: Array<{ id: string; body: string; url: string | null; createdAt: string; author: GhActor | null }> }
}

export interface GhPullFile {
  filename: string
  previous_filename?: string | null
  status: string
  additions: number
  deletions: number
  patch?: string
}

const GHOST: PrPerson = { login: 'ghost', displayName: 'ghost', avatarUrl: null }

export function mapGhActor(actor: GhActor | null | undefined): PrPerson {
  if (!actor) return GHOST
  return { login: actor.login, displayName: actor.name || actor.login, avatarUrl: actor.avatarUrl ?? null }
}

const REVIEW_STATE: Record<string, ReviewState> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
  PENDING: 'pending',
}

const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED'])

/** A GitHub Actions job links to `/<owner>/<repo>/actions/runs/<run id>/job/<job id>`; other apps' checks do not re-run from here. */
export function actionsRunId(detailsUrl: string | null | undefined): string | null {
  const m = /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/(\d+)(?:[/?#]|$)/.exec(detailsUrl ?? '')
  return m ? m[1] : null
}

export function mapGhCheck(ctx: GhCheckContext, index: number): PrCheck {
  if (ctx.__typename === 'CheckRun') {
    let state: CheckState
    if (ctx.status !== 'COMPLETED') state = 'pending'
    else if (ctx.conclusion === 'SUCCESS') state = 'success'
    else if (ctx.conclusion === 'SKIPPED') state = 'skipped'
    else if (ctx.conclusion && FAILED_CONCLUSIONS.has(ctx.conclusion)) state = 'failure'
    else state = 'neutral'
    const started = parseTime(ctx.startedAt)
    const completed = parseTime(ctx.completedAt)
    return {
      id: `run:${index}:${ctx.name}`,
      name: ctx.name,
      state,
      description: null,
      url: ctx.detailsUrl,
      durationMs: started !== null && completed !== null && state !== 'pending' ? completed - started : null,
      rerunId: actionsRunId(ctx.detailsUrl),
    }
  }
  const state: CheckState =
    ctx.state === 'SUCCESS' ? 'success' : ctx.state === 'FAILURE' || ctx.state === 'ERROR' ? 'failure' : 'pending'
  return { id: `status:${index}:${ctx.context}`, name: ctx.context, state, description: ctx.description, url: ctx.targetUrl, durationMs: null, rerunId: null }
}

export function mapGhChecks(pr: Pick<GhPullRequest, 'commits'>): PrCheck[] {
  const contexts = pr.commits?.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []
  return contexts.map(mapGhCheck)
}

function mapReviewers(pr: GhPullRequest): PrReviewer[] {
  const byLogin = new Map<string, PrReviewer>()
  for (const review of pr.latestReviews?.nodes ?? []) {
    if (!review.author) continue
    byLogin.set(review.author.login, {
      id: review.author.login,
      person: mapGhActor(review.author),
      state: REVIEW_STATE[review.state] ?? 'commented',
      requested: false,
    })
  }
  // A request outstanding after a review means it was asked for again, so the review is owed anew.
  for (const request of pr.reviewRequests?.nodes ?? []) {
    const r = request.requestedReviewer
    if (r?.__typename === 'Team' && r.slug) {
      const id = `team:${r.slug}`
      byLogin.set(id, { id, person: { login: r.slug, displayName: r.name || r.slug, avatarUrl: null }, state: 'pending', requested: true })
      continue
    }
    if (!r || r.__typename !== 'User' || !r.login) continue
    byLogin.set(r.login, { id: r.login, person: mapGhActor(r as GhActor), state: 'pending', requested: true })
  }
  return [...byLogin.values()]
}

const STATE: Record<GhPullRequest['state'], PrSummary['state']> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }

export function mapGhSummary(repo: RepoRef, pr: GhPullRequest, viewerLogin: string): PrSummary {
  const reviewers = mapReviewers(pr)
  const viewer = viewerLogin.toLowerCase()
  const isViewer = (login: string) => login.toLowerCase() === viewer
  const threads = pr.reviewThreads?.nodes
  const viewerReviews = (pr.latestReviews?.nodes ?? []).filter((r) => r.author && isViewer(r.author.login))
  return {
    ref: { ...repo, number: pr.number },
    title: pr.title,
    url: pr.url,
    author: mapGhActor(pr.author),
    authorId: pr.author?.login ?? null,
    state: STATE[pr.state],
    draft: pr.isDraft,
    sourceBranch: pr.headRefName,
    targetBranch: pr.baseRefName,
    createdAt: parseTime(pr.createdAt) ?? 0,
    updatedAt: parseTime(pr.updatedAt) ?? 0,
    mergedAt: parseTime(pr.mergedAt),
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    changedFiles: pr.changedFiles ?? null,
    unresolvedConversations: threads ? threads.filter((t) => !t.isResolved).length : null,
    mergeConflicts: pr.state !== 'OPEN' ? false : pr.mergeable === 'CONFLICTING' ? true : pr.mergeable === 'MERGEABLE' ? false : null,
    // GitHub's API says that a PR conflicts, never where.
    conflictedFiles: [],
    checks: rollupChecks(mapGhChecks(pr)),
    reviewers,
    approvals: {
      given: reviewers.filter((r) => r.state === 'approved').length,
      required: pr.baseRef?.branchProtectionRule?.requiredApprovingReviewCount ?? null,
    },
    viewer: {
      isAuthor: !!pr.author && isViewer(pr.author.login),
      isRequestedReviewer: reviewers.some((r) => r.requested && r.id !== null && isViewer(r.id)),
      hasReviewed: viewerReviews.some((r) => r.state !== 'PENDING' && r.state !== 'COMMENTED'),
      // Inline comments always come in a review; a comment on the conversation tab does not, and the list cannot see it cheaply.
      hasCommented: viewerReviews.some((r) => r.state === 'COMMENTED'),
    },
    projectPaths: [],
  }
}

function excerpt(text: string, max = 140): string {
  const flat = stripHtmlComments(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const REVIEW_PHRASE: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'requested changes',
  COMMENTED: 'reviewed',
  DISMISSED: 'had a review dismissed',
}

/** Timeline -> activity, oldest first. Consecutive commits fold into one "pushed N commits" row. */
export function mapGhActivity(items: readonly GhTimelineItem[]): PrActivity[] {
  const out: PrActivity[] = []
  let pushRun: { row: PrActivity; count: number } | null = null
  items.forEach((item, i) => {
    if (item.__typename === 'PullRequestCommit' && item.commit) {
      const at = parseTime(item.commit.committedDate) ?? 0
      const actor = item.commit.author?.user ? mapGhActor(item.commit.author.user) : null
      if (pushRun && pushRun.row.actor?.login === actor?.login) {
        pushRun.count++
        pushRun.row.summary = `pushed ${pushRun.count} commits`
        pushRun.row.detail = item.commit.messageHeadline
        pushRun.row.at = at
        return
      }
      const row: PrActivity = { id: `commit:${item.commit.oid}`, kind: 'pushed', actor, summary: 'pushed a commit', detail: item.commit.messageHeadline, at }
      pushRun = { row, count: 1 }
      out.push(row)
      return
    }
    pushRun = null
    if (item.__typename === 'PullRequestReview' && item.state && item.state !== 'PENDING') {
      const count = item.comments?.totalCount ?? 0
      out.push({
        id: `review:${i}`,
        kind: 'reviewed',
        actor: mapGhActor(item.author),
        summary: REVIEW_PHRASE[item.state] ?? 'reviewed',
        detail: count > 0 ? (count === 1 ? '1 comment' : `${count} comments`) : null,
        at: parseTime(item.submittedAt) ?? 0,
      })
    } else if (item.__typename === 'IssueComment') {
      out.push({ id: `comment:${i}`, kind: 'commented', actor: mapGhActor(item.author), summary: 'commented', detail: excerpt(item.body ?? ''), at: parseTime(item.createdAt) ?? 0 })
    } else if (item.__typename === 'MergedEvent') {
      out.push({ id: `merged:${i}`, kind: 'merged', actor: mapGhActor(item.actor), summary: 'merged', detail: null, at: parseTime(item.createdAt) ?? 0 })
    }
  })
  return out
}

export function mapGhMergeStrategies(settings: GhRepoMergeSettings): MergeStrategy[] {
  const allowed: MergeStrategy[] = []
  if (settings.mergeCommitAllowed) allowed.push('merge_commit')
  if (settings.squashMergeAllowed) allowed.push('squash')
  if (settings.rebaseMergeAllowed) allowed.push('rebase')
  return orderMergeStrategies(allowed)
}

export function mapGhDetail(repo: RepoRef, pr: GhPullRequestDetail, viewerLogin: string, settings: GhRepoMergeSettings): PrDetail {
  const summary = mapGhSummary(repo, pr, viewerLogin)
  return {
    ...summary,
    description: stripHtmlComments(pr.body ?? ''),
    headSha: pr.headRefOid ?? null,
    mergeBlockers: mergeBlockers(summary),
    mergeStrategies: mapGhMergeStrategies(settings),
    activity: mapGhActivity(pr.timelineItems?.nodes ?? []),
    checkList: mapGhChecks(pr),
    // Closing and requesting reviewers both need write access, or authorship.
    viewerCanManage: summary.viewer.isAuthor || ['ADMIN', 'MAINTAIN', 'WRITE'].includes(settings.viewerPermission ?? ''),
  }
}

/** A range that starts on the other side is shown as its last line only: the diff view has no way to draw it. */
function ghStartLine(t: GhReviewThread): number | undefined {
  if (t.isOutdated || t.line === null || !t.startLine || t.startLine >= t.line) return undefined
  return (t.startDiffSide ?? t.diffSide) === t.diffSide ? t.startLine : undefined
}

export function mapGhThreads(threads: readonly GhReviewThread[]): PrConversation[] {
  return threads.map((t) => {
    const startLine = ghStartLine(t)
    return {
      id: t.id,
      path: t.path,
      line: t.isOutdated ? null : t.line,
      ...(startLine !== undefined ? { startLine } : {}),
      side: t.diffSide === 'LEFT' ? 'old' : 'new',
      resolved: t.isResolved,
      outdated: t.isOutdated,
      comments: t.comments.nodes.map((c) => ({
        id: c.id,
        author: mapGhActor(c.author),
        body: stripHtmlComments(c.body),
        createdAt: parseTime(c.createdAt) ?? 0,
        url: c.url,
      })),
    }
  })
}

export interface GhCollaborator {
  login: string
  avatar_url?: string | null
}

export interface GhTeam {
  slug: string
  name?: string | null
}

export function mapGhCandidates(collaborators: readonly GhCollaborator[], teams: readonly GhTeam[]): PrReviewerCandidate[] {
  return [
    ...collaborators.map((c): PrReviewerCandidate => ({ id: c.login, person: { login: c.login, displayName: c.login, avatarUrl: c.avatar_url ?? null }, kind: 'user', reviewed: 0 })),
    ...teams.map((t): PrReviewerCandidate => ({ id: `team:${t.slug}`, person: { login: t.slug, displayName: t.name || t.slug, avatarUrl: null }, kind: 'team', reviewed: 0 })),
  ]
}

const FILE_STATUS: Record<string, ChangedFileStatus> = {
  added: 'added',
  removed: 'deleted',
  modified: 'modified',
  changed: 'modified',
  renamed: 'renamed',
  copied: 'added',
  unchanged: 'modified',
}

export function mapGhFiles(files: readonly GhPullFile[]): PrChangedFile[] {
  return files.map((f) => {
    // GitHub omits `patch` for binary files and for diffs it considers too large.
    const parsed = f.patch ? parseHunks(f.patch) : { hunks: [], truncated: false }
    const noPatch = f.patch === undefined && f.additions + f.deletions > 0
    return {
      path: f.filename,
      oldPath: f.previous_filename ?? null,
      status: FILE_STATUS[f.status] ?? 'modified',
      additions: f.additions,
      deletions: f.deletions,
      binary: f.patch === undefined && f.additions + f.deletions === 0 && f.status !== 'renamed',
      truncated: parsed.truncated || noPatch,
      hunks: parsed.hunks,
    }
  })
}

/** `gh` stderr / exit -> the error the UI explains. */
export function classifyGhError(err: { code?: string | number | null; stderr?: string; message?: string }): PrError {
  const text = `${err.stderr ?? ''}\n${err.message ?? ''}`
  if (err.code === 'ENOENT') {
    return { kind: 'gh_missing', host: 'github', message: 'The gh CLI is not installed where the backend runs.' }
  }
  if (/gh auth login|not logged in|authentication required|HTTP 401|Bad credentials/i.test(text)) {
    return { kind: 'token_rejected', host: 'github', message: 'gh is signed out or its token was rejected.' }
  }
  if (/rate limit/i.test(text)) {
    return { kind: 'rate_limited', host: 'github', message: 'GitHub rate limit reached.' }
  }
  if (/Could not resolve to a Repository|HTTP 404|Not Found/i.test(text)) {
    return { kind: 'not_found', host: 'github', message: 'GitHub could not find it, or this account cannot see it.' }
  }
  if (/error connecting|dial tcp|no such host|ENOTFOUND|ECONNRESET|ETIMEDOUT|i\/o timeout|network is unreachable/i.test(text)) {
    return { kind: 'offline', host: 'github', message: 'Could not reach github.com.' }
  }
  const firstLine = (err.stderr ?? err.message ?? '').split('\n').find((l) => l.trim()) ?? 'gh failed'
  return { kind: 'unknown', host: 'github', message: firstLine.trim().slice(0, 200) }
}

/** The code `defaultGhRunner` gives a gh it killed for taking too long. */
export const GH_TIMED_OUT = 'GH_TIMEOUT'

/**
 * A server-side failure worth one more try: gh's `HTTP 500/502/503/504`,
 * GitHub's GraphQL "Something went wrong while executing your query" (how it
 * reports a timed-out resolver), a body cut short (gh's Go JSON decoder says
 * "unexpected end of JSON input" or "unexpected EOF"), or a gh that did not
 * answer in time. Only stderr is read: stdout can hold PR text that mentions
 * anything. Reads only; a write is never re-sent.
 */
export function isTransientGhFailure(res: { code?: string | number | null; stderr?: string }): boolean {
  if (res.code === GH_TIMED_OUT) return true
  if (res.code === 0 || res.code === 'ENOENT') return false
  const text = res.stderr ?? ''
  return /HTTP 50[0234]\b/.test(text)
    || /something went wrong while executing your query/i.test(text)
    || /unexpected end of JSON input|unexpected EOF/i.test(text)
}

interface GhErrorBody {
  message?: string
  errors?: Array<{ type?: string; message?: string } | string>
}

function ghErrorMessage(stdout: string | undefined): { message: string | null; graphqlType: string | null } {
  if (!stdout?.trim()) return { message: null, graphqlType: null }
  try {
    const body = JSON.parse(stdout) as GhErrorBody
    const first = body.errors?.[0]
    const graphqlType = typeof first === 'object' && first?.type ? first.type : null
    const detail = typeof first === 'string' ? first : first?.message
    // REST puts the reason in `message` and the specifics in `errors`; GraphQL has only `errors`.
    const message = body.message && detail && body.message !== detail ? `${body.message}: ${detail}` : body.message ?? detail ?? null
    return { message: message ? message.slice(0, 300) : null, graphqlType }
  } catch (err) {
    // Not JSON: gh printed only to stderr, which the caller reads instead.
    log.debug('gh write error body is not JSON', { bytes: stdout.length, err: String(err) })
    return { message: null, graphqlType: null }
  }
}

const GRAPHQL_KIND: Record<string, PrError['kind']> = {
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'stale',
  UNPROCESSABLE: 'invalid',
  RATE_LIMITED: 'rate_limited',
}

/**
 * A refused write -> the typed error. gh prints `... (HTTP 409)` on stderr
 * and the host's JSON answer on stdout; GraphQL mutations answer with a
 * typed `errors[]`.
 */
export function classifyGhWriteError(res: { code?: string | number | null; stdout?: string; stderr?: string }): PrError {
  if (res.code === 'ENOENT') return classifyGhError(res)
  const stderr = res.stderr ?? ''
  const status = Number(/HTTP (\d{3})/.exec(stderr)?.[1] ?? 0)
  const { message, graphqlType } = ghErrorMessage(res.stdout)
  const said = message ?? stderr.split('\n').find((l) => l.trim())?.replace(/^gh:\s*/, '').replace(/\s*\(HTTP \d{3}\)\s*$/, '').trim() ?? ''
  const err = (kind: PrError['kind'], fallback: string): PrError => ({ kind, host: 'github', message: said || fallback })
  if (status === 429 || /rate limit/i.test(`${stderr}\n${message ?? ''}`) || graphqlType === 'RATE_LIMITED') {
    return { kind: 'rate_limited', host: 'github', message: 'GitHub rate limit reached.' }
  }
  if (graphqlType && GRAPHQL_KIND[graphqlType]) return err(GRAPHQL_KIND[graphqlType], 'GitHub refused the change.')
  switch (status) {
    case 401: return { kind: 'token_rejected', host: 'github', message: 'gh is signed out or its token was rejected.' }
    case 403: return err('forbidden', 'GitHub does not let this account do that.')
    case 404: return err('not_found', 'GitHub could not find it, or this account cannot see it.')
    case 405: return err('conflict', 'GitHub says the pull request cannot be merged.')
    case 409: return err('stale', 'The pull request changed on GitHub. Refresh and try again.')
    case 422:
      if (/pending review/i.test(said)) return err('conflict', 'You already have a pending review on GitHub.')
      if (/your own pull request/i.test(said)) return err('forbidden', 'You cannot approve your own pull request.')
      return err('invalid', 'GitHub refused the input.')
  }
  return classifyGhError(res)
}
