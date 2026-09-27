/**
 * Bitbucket Cloud REST 2.0 JSON -> neutral pull request types. Pure.
 *
 * Shapes follow developer.atlassian.com/cloud/bitbucket/rest (pullrequests,
 * diffstat, comments, activity, commit statuses).
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
  type PrPerson,
  type PrReviewer,
  type PrSummary,
  type RepoRef,
  type ReviewState,
} from '@shared/pull-requests'
import { parseHunks, splitGitDiff } from '@shared/unified-diff'
import { parseTime } from './provider'

export interface BbUser {
  display_name?: string
  nickname?: string
  uuid?: string
  account_id?: string
  links?: { avatar?: { href?: string } }
}

export interface BbParticipant {
  user: BbUser
  role: 'PARTICIPANT' | 'REVIEWER'
  approved: boolean
  state?: 'approved' | 'changes_requested' | null
  participated_on?: string | null
}

export interface BbPullRequest {
  id: number
  title: string
  description?: string
  state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED'
  draft?: boolean
  author?: BbUser
  source: { branch: { name: string }; commit?: { hash: string } | null }
  destination: { branch: { name: string } }
  comment_count?: number
  created_on: string
  updated_on: string
  links: { html: { href: string } }
  participants?: BbParticipant[]
  reviewers?: BbUser[]
}

export interface BbDiffstat {
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'merge conflict' | 'local deleted' | 'remote deleted'
  lines_added: number
  lines_removed: number
  old?: { path: string } | null
  new?: { path: string } | null
}

export interface BbComment {
  id: number
  content: { raw: string }
  user?: BbUser
  created_on: string
  deleted?: boolean
  parent?: { id: number }
  inline?: { path: string; from?: number | null; to?: number | null; outdated?: boolean }
  resolution?: { type?: string; created_on?: string } | null
  links?: { html?: { href?: string } }
}

export interface BbStatus {
  key: string
  name?: string | null
  state: 'SUCCESSFUL' | 'FAILED' | 'INPROGRESS' | 'STOPPED'
  url?: string | null
  description?: string | null
  created_on?: string
  updated_on?: string
}

export interface BbActivity {
  approval?: { date: string; user: BbUser }
  changes_requested?: { date: string; user: BbUser }
  update?: { date: string; author: BbUser; state?: string; source?: { commit?: { hash?: string } } }
  comment?: BbComment
}

export interface BbViewer {
  uuid: string | null
  accountId: string | null
}

export interface BbEnrichment {
  checks: PrCheck[]
  unresolvedConversations: number | null
}

export function mapBbUser(user: BbUser | null | undefined): PrPerson {
  const name = user?.display_name || user?.nickname || 'Former user'
  return { login: user?.nickname || name, displayName: name, avatarUrl: user?.links?.avatar?.href ?? null }
}

function sameUser(user: BbUser | undefined, viewer: BbViewer): boolean {
  if (!user) return false
  return (!!viewer.uuid && user.uuid === viewer.uuid) || (!!viewer.accountId && user.account_id === viewer.accountId)
}

function participantState(p: BbParticipant): ReviewState {
  if (p.state === 'changes_requested') return 'changes_requested'
  if (p.state === 'approved' || p.approved) return 'approved'
  return p.participated_on ? 'commented' : 'pending'
}

function mapReviewers(pr: BbPullRequest): PrReviewer[] {
  const out = new Map<string, PrReviewer>()
  for (const p of pr.participants ?? []) {
    const key = p.user.uuid ?? p.user.account_id ?? p.user.display_name ?? String(out.size)
    out.set(key, { person: mapBbUser(p.user), state: participantState(p), requested: p.role === 'REVIEWER' })
  }
  // `reviewers` lists requested reviewers who have not participated yet.
  for (const u of pr.reviewers ?? []) {
    const key = u.uuid ?? u.account_id ?? u.display_name ?? String(out.size)
    if (!out.has(key)) out.set(key, { person: mapBbUser(u), state: 'pending', requested: true })
  }
  return [...out.values()]
}

const STATE: Record<BbPullRequest['state'], PrSummary['state']> = { OPEN: 'open', MERGED: 'merged', DECLINED: 'closed', SUPERSEDED: 'closed' }

export function mapBbSummary(repo: RepoRef, pr: BbPullRequest, viewer: BbViewer, extra: BbEnrichment | null): PrSummary {
  const reviewers = mapReviewers(pr)
  const viewerParticipant = (pr.participants ?? []).find((p) => sameUser(p.user, viewer))
  const viewerRequested = (pr.reviewers ?? []).some((u) => sameUser(u, viewer)) || viewerParticipant?.role === 'REVIEWER'
  const viewerReviewed = !!viewerParticipant && (viewerParticipant.approved || !!viewerParticipant.state)
  return {
    ref: { ...repo, number: pr.id },
    title: pr.title,
    url: pr.links.html.href,
    author: mapBbUser(pr.author),
    state: STATE[pr.state],
    draft: !!pr.draft,
    sourceBranch: pr.source.branch.name,
    targetBranch: pr.destination.branch.name,
    createdAt: parseTime(pr.created_on) ?? 0,
    updatedAt: parseTime(pr.updated_on) ?? 0,
    // Bitbucket has no merge time; a merged PR's last update is its merge.
    mergedAt: pr.state === 'MERGED' ? parseTime(pr.updated_on) : null,
    additions: null,
    deletions: null,
    changedFiles: null,
    unresolvedConversations: extra?.unresolvedConversations ?? null,
    checks: rollupChecks(extra?.checks ?? []),
    reviewers,
    approvals: { given: reviewers.filter((r) => r.state === 'approved').length, required: null },
    viewer: {
      isAuthor: sameUser(pr.author, viewer),
      isRequestedReviewer: viewerRequested && !viewerReviewed,
      hasReviewed: viewerReviewed,
    },
    projectPaths: [],
  }
}

const STATUS_STATE: Record<BbStatus['state'], CheckState> = {
  SUCCESSFUL: 'success',
  FAILED: 'failure',
  INPROGRESS: 'pending',
  STOPPED: 'neutral',
}

export function mapBbStatuses(statuses: readonly BbStatus[]): PrCheck[] {
  return statuses.map((s) => {
    const state = STATUS_STATE[s.state] ?? 'neutral'
    const created = parseTime(s.created_on)
    const updated = parseTime(s.updated_on)
    return {
      id: s.key,
      name: s.name || s.key,
      state,
      description: s.description || null,
      url: s.url || null,
      // First post to last post: close to the run time for Pipelines, which posts at start and end.
      durationMs: state !== 'pending' && created !== null && updated !== null && updated > created ? updated - created : null,
    }
  })
}

/** Inline comments -> threads. Replies join their root through the parent chain; a deleted root keeps its replies. */
export function mapBbComments(comments: readonly BbComment[]): PrConversation[] {
  const byId = new Map(comments.map((c) => [c.id, c]))
  const rootOf = (c: BbComment): BbComment => {
    let cur = c
    const seen = new Set<number>()
    while (cur.parent && byId.has(cur.parent.id) && !seen.has(cur.id)) {
      seen.add(cur.id)
      cur = byId.get(cur.parent.id)!
    }
    return cur
  }
  const threads = new Map<number, PrConversation>()
  const ordered = [...comments].sort((a, b) => (parseTime(a.created_on) ?? 0) - (parseTime(b.created_on) ?? 0))
  for (const c of ordered) {
    const root = rootOf(c)
    if (!root.inline) continue
    let thread = threads.get(root.id)
    if (!thread) {
      const { path, from, to, outdated } = root.inline
      const line = to ?? from ?? null
      thread = {
        id: String(root.id),
        path,
        line: outdated ? null : line,
        side: to != null ? 'new' : from != null ? 'old' : null,
        resolved: !!root.resolution,
        outdated: !!outdated,
        comments: [],
      }
      threads.set(root.id, thread)
    }
    if (c.deleted) continue
    thread.comments.push({
      id: String(c.id),
      author: mapBbUser(c.user),
      body: stripHtmlComments(c.content.raw ?? ''),
      createdAt: parseTime(c.created_on) ?? 0,
      url: c.links?.html?.href ?? null,
    })
  }
  return [...threads.values()].filter((t) => t.comments.length > 0)
}

export function unresolvedCount(conversations: readonly PrConversation[]): number {
  return conversations.filter((c) => !c.resolved).length
}

function excerpt(text: string, max = 140): string {
  const flat = stripHtmlComments(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Activity comes newest first from the API; returned oldest first like the GitHub timeline. */
export function mapBbActivity(entries: readonly BbActivity[]): PrActivity[] {
  const out: PrActivity[] = []
  entries.forEach((e, i) => {
    if (e.approval) {
      out.push({ id: `approval:${i}`, kind: 'reviewed', actor: mapBbUser(e.approval.user), summary: 'approved', detail: null, at: parseTime(e.approval.date) ?? 0 })
    } else if (e.changes_requested) {
      out.push({ id: `changes:${i}`, kind: 'reviewed', actor: mapBbUser(e.changes_requested.user), summary: 'requested changes', detail: null, at: parseTime(e.changes_requested.date) ?? 0 })
    } else if (e.comment && !e.comment.deleted) {
      const where = e.comment.inline?.path
      out.push({
        id: `comment:${e.comment.id}`,
        kind: 'commented',
        actor: mapBbUser(e.comment.user),
        summary: 'commented',
        detail: where ? `${where}: "${excerpt(e.comment.content.raw, 100)}"` : excerpt(e.comment.content.raw),
        at: parseTime(e.comment.created_on) ?? 0,
      })
    } else if (e.update) {
      const at = parseTime(e.update.date) ?? 0
      const hash = e.update.source?.commit?.hash
      if (e.update.state === 'MERGED') out.push({ id: `merged:${i}`, kind: 'merged', actor: mapBbUser(e.update.author), summary: 'merged', detail: null, at })
      else out.push({ id: `update:${i}`, kind: 'pushed', actor: mapBbUser(e.update.author), summary: 'updated the pull request', detail: hash ? `head ${hash.slice(0, 7)}` : null, at })
    }
  })
  // Consecutive updates to the same head collapse to the latest (the API lists newest first); Bitbucket logs one per field edit.
  const deduped = out.filter((row, i) => !(row.kind === 'pushed' && out[i - 1]?.kind === 'pushed' && out[i - 1]?.detail === row.detail))
  return deduped.sort((a, b) => a.at - b.at)
}

export function mapBbDetail(
  repo: RepoRef,
  pr: BbPullRequest,
  viewer: BbViewer,
  extra: BbEnrichment,
  diffstat: readonly BbDiffstat[],
  activity: readonly BbActivity[],
): PrDetail {
  const summary = mapBbSummary(repo, pr, viewer, extra)
  const withStats: PrSummary = {
    ...summary,
    additions: diffstat.reduce((n, d) => n + d.lines_added, 0),
    deletions: diffstat.reduce((n, d) => n + d.lines_removed, 0),
    changedFiles: diffstat.length,
  }
  return {
    ...withStats,
    description: stripHtmlComments(pr.description ?? ''),
    headSha: pr.source.commit?.hash ?? null,
    mergeBlockers: mergeBlockers(withStats, { conflicts: diffstat.some((d) => d.status === 'merge conflict') }),
    activity: mapBbActivity(activity),
    checkList: extra.checks,
  }
}

const FILE_STATUS: Record<BbDiffstat['status'], ChangedFileStatus> = {
  added: 'added',
  removed: 'deleted',
  modified: 'modified',
  renamed: 'renamed',
  'merge conflict': 'modified',
  'local deleted': 'deleted',
  'remote deleted': 'deleted',
}

export function mapBbFiles(diffstat: readonly BbDiffstat[], diffText: string): PrChangedFile[] {
  const patches = new Map<string, ReturnType<typeof splitGitDiff>[number]>()
  for (const file of splitGitDiff(diffText)) patches.set((file.newPath ?? file.oldPath) ?? '', file)
  return diffstat.map((d) => {
    const path = d.new?.path ?? d.old?.path ?? ''
    const patch = patches.get(path)
    const parsed = patch ? parseHunks(patch.patch) : { hunks: [], truncated: false }
    return {
      path,
      oldPath: d.status === 'renamed' ? d.old?.path ?? null : null,
      status: FILE_STATUS[d.status] ?? 'modified',
      additions: d.lines_added,
      deletions: d.lines_removed,
      binary: !!patch?.binary,
      truncated: parsed.truncated || (!patch && d.lines_added + d.lines_removed > 0),
      hunks: parsed.hunks,
    }
  })
}
