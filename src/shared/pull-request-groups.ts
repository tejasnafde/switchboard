/**
 * The Reviews list: which group a pull request sits in, and the one status
 * signal its row shows (an icon and a short phrase, never a coloured chip).
 *
 * Groups say what you do next:
 *
 * - Needs you: you were asked to review and have not, or it is your PR and
 *   something is on you (failed checks, open conversations, changes
 *   requested).
 * - Ready to merge: your PR, open, with nothing blocking it.
 * - Waiting on others: every other open PR you are part of.
 * - Merged this week: merged in the last 7 days.
 *
 * Closed-without-merge and older merged PRs are not listed.
 */
import { mergeBlockers, type PrSummary } from './pull-requests'

export type PrGroupId = 'needs-you' | 'waiting' | 'ready' | 'merged'

export const PR_GROUP_ORDER: readonly PrGroupId[] = ['needs-you', 'waiting', 'ready', 'merged']

export const PR_GROUP_LABEL: Record<PrGroupId, string> = {
  'needs-you': 'Needs you',
  waiting: 'Waiting on others',
  ready: 'Ready to merge',
  merged: 'Merged this week',
}

export const MERGED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Row icon. The renderer maps each to one glyph and one tone. */
export type PrRowIcon = 'failed' | 'review' | 'conversation' | 'running' | 'waiting' | 'ready' | 'merged' | 'draft'

export interface PrRowStatus {
  group: PrGroupId
  icon: PrRowIcon
  /** Short phrase after the repo and number: "build failed", "your review". Empty when the group says it all. */
  phrase: string
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function approvalsPhrase(pr: PrSummary): string {
  const { given, required } = pr.approvals
  if (required !== null && required > 0) return `${given} of ${required} approvals`
  return given > 0 ? plural(given, 'approval') : 'waiting for review'
}

/** `null` when the PR is not listed at all. */
export function prRowStatus(pr: PrSummary, now: number): PrRowStatus | null {
  if (pr.state === 'merged') {
    if (pr.mergedAt === null || now - pr.mergedAt > MERGED_WINDOW_MS) return null
    return { group: 'merged', icon: 'merged', phrase: '' }
  }
  if (pr.state !== 'open') return null

  if (!pr.viewer.isAuthor) {
    if (pr.viewer.isRequestedReviewer) return { group: 'needs-you', icon: 'review', phrase: 'your review' }
    if (pr.checks.state === 'pending') return { group: 'waiting', icon: 'running', phrase: 'checks running' }
    return { group: 'waiting', icon: 'waiting', phrase: pr.viewer.hasReviewed ? 'you reviewed' : approvalsPhrase(pr) }
  }

  if (pr.draft) return { group: 'waiting', icon: 'draft', phrase: 'draft' }
  if (pr.checks.state === 'failure') return { group: 'needs-you', icon: 'failed', phrase: 'build failed' }
  const open = pr.unresolvedConversations ?? 0
  if (open > 0) return { group: 'needs-you', icon: 'conversation', phrase: plural(open, 'open conversation') }
  if (pr.reviewers.some((r) => r.state === 'changes_requested')) {
    return { group: 'needs-you', icon: 'conversation', phrase: 'changes requested' }
  }
  if (pr.checks.state === 'pending') return { group: 'waiting', icon: 'running', phrase: 'checks running' }
  const { given, required } = pr.approvals
  const approved = required !== null ? given >= required : given > 0
  if (approved && mergeBlockers(pr).length === 0) return { group: 'ready', icon: 'ready', phrase: '' }
  return { group: 'waiting', icon: 'waiting', phrase: approvalsPhrase(pr) }
}

export interface PrGroup {
  id: PrGroupId
  label: string
  prs: Array<{ pr: PrSummary; status: PrRowStatus }>
}

/** Groups in display order, empty ones dropped. Newest update first inside a group; merged by merge time. */
export function groupPullRequests(prs: readonly PrSummary[], now: number): PrGroup[] {
  const buckets = new Map<PrGroupId, PrGroup['prs']>()
  for (const pr of prs) {
    const status = prRowStatus(pr, now)
    if (!status) continue
    const list = buckets.get(status.group) ?? []
    list.push({ pr, status })
    buckets.set(status.group, list)
  }
  const out: PrGroup[] = []
  for (const id of PR_GROUP_ORDER) {
    const list = buckets.get(id)
    if (!list?.length) continue
    const at = (pr: PrSummary) => (id === 'merged' ? pr.mergedAt ?? 0 : pr.updatedAt)
    list.sort((a, b) => at(b.pr) - at(a.pr))
    out.push({ id, label: PR_GROUP_LABEL[id], prs: list })
  }
  return out
}

/** Case-insensitive filter over title, repo, number and author. */
export function filterPullRequests<T extends PrSummary>(prs: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase().replace(/^#/, '')
  if (!q) return [...prs]
  return prs.filter((pr) =>
    [pr.title, pr.ref.name, pr.ref.owner, String(pr.ref.number), pr.author.login, pr.author.displayName, pr.sourceBranch]
      .some((field) => field.toLowerCase().includes(q)))
}
