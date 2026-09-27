/**
 * GitHub GraphQL / REST JSON -> neutral pull request types. Pure; the
 * queries that produce this JSON live beside the types in `github.ts`.
 */
import {
  mergeBlockers,
  rollupChecks,
  stripHtmlComments,
  type ChangedFileStatus,
  type CheckState,
  type PrActivity,
  type PrChangedFile,
  type PrCheck,
  type PrConversation,
  type PrDetail,
  type PrError,
  type PrPerson,
  type PrReviewer,
  type PrSummary,
  type RepoRef,
  type ReviewState,
} from '@shared/pull-requests'
import { parseHunks } from '@shared/unified-diff'
import { parseTime } from './provider'

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
  reviewRequests?: { nodes: Array<{ requestedReviewer: ({ __typename: string } & Partial<GhActor>) | null }> }
  latestReviews?: { nodes: Array<{ state: string; author: GhActor | null; submittedAt: string | null }> }
  reviewThreads?: { totalCount: number; nodes: Array<{ isResolved: boolean }> }
  commits?: { nodes: Array<{ commit: { statusCheckRollup: { state: string; contexts: { nodes: GhCheckContext[] } } | null } }> }
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
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  timelineItems?: { nodes: GhTimelineItem[] }
}

export interface GhReviewThread {
  id: string
  isResolved: boolean
  isOutdated: boolean
  path: string
  line: number | null
  originalLine: number | null
  diffSide: 'LEFT' | 'RIGHT'
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
    }
  }
  const state: CheckState =
    ctx.state === 'SUCCESS' ? 'success' : ctx.state === 'FAILURE' || ctx.state === 'ERROR' ? 'failure' : 'pending'
  return { id: `status:${index}:${ctx.context}`, name: ctx.context, state, description: ctx.description, url: ctx.targetUrl, durationMs: null }
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
      person: mapGhActor(review.author),
      state: REVIEW_STATE[review.state] ?? 'commented',
      requested: false,
    })
  }
  // A request outstanding after a review means it was asked for again, so the review is owed anew.
  for (const request of pr.reviewRequests?.nodes ?? []) {
    const r = request.requestedReviewer
    if (!r || r.__typename !== 'User' || !r.login) continue
    byLogin.set(r.login, { person: mapGhActor(r as GhActor), state: 'pending', requested: true })
  }
  return [...byLogin.values()]
}

const STATE: Record<GhPullRequest['state'], PrSummary['state']> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }

export function mapGhSummary(repo: RepoRef, pr: GhPullRequest, viewerLogin: string): PrSummary {
  const reviewers = mapReviewers(pr)
  const viewer = viewerLogin.toLowerCase()
  const isViewer = (login: string) => login.toLowerCase() === viewer
  const threads = pr.reviewThreads?.nodes
  return {
    ref: { ...repo, number: pr.number },
    title: pr.title,
    url: pr.url,
    author: mapGhActor(pr.author),
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
    checks: rollupChecks(mapGhChecks(pr)),
    reviewers,
    approvals: {
      given: reviewers.filter((r) => r.state === 'approved').length,
      required: pr.baseRef?.branchProtectionRule?.requiredApprovingReviewCount ?? null,
    },
    viewer: {
      isAuthor: !!pr.author && isViewer(pr.author.login),
      isRequestedReviewer: reviewers.some((r) => r.requested && isViewer(r.person.login)),
      hasReviewed: (pr.latestReviews?.nodes ?? []).some((r) => r.author && isViewer(r.author.login) && r.state !== 'PENDING'),
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

export function mapGhDetail(repo: RepoRef, pr: GhPullRequestDetail, viewerLogin: string): PrDetail {
  const summary = mapGhSummary(repo, pr, viewerLogin)
  return {
    ...summary,
    description: stripHtmlComments(pr.body ?? ''),
    headSha: pr.headRefOid ?? null,
    mergeBlockers: mergeBlockers(summary, { conflicts: pr.mergeable === 'CONFLICTING' }),
    activity: mapGhActivity(pr.timelineItems?.nodes ?? []),
    checkList: mapGhChecks(pr),
  }
}

export function mapGhThreads(threads: readonly GhReviewThread[]): PrConversation[] {
  return threads.map((t) => ({
    id: t.id,
    path: t.path,
    line: t.isOutdated ? null : t.line,
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
  }))
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
