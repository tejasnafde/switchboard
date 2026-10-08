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
 * - Your pull requests: your other open PRs (waiting for review, checks
 *   running, a draft, approvals pending).
 * - Reviewing: someone else's open PR you are part of and nothing is owed
 *   (you reviewed, you commented, conflicts or checks on their side).
 * - Merged this week: merged in the last 7 days.
 *
 * Closed-without-merge and older merged PRs are not listed.
 *
 * The list shows those groups (by status, the default) or one collapsible
 * section per repository with the rows in the same status order. A PR the
 * user hid is left out until `hiddenComesBack` says otherwise.
 */
import { mergeBlockers, prKey, repoKey, type PrSummary } from './pull-requests'

export type PrGroupId = 'needs-you' | 'ready' | 'yours' | 'reviewing' | 'merged'

export const PR_GROUP_ORDER: readonly PrGroupId[] = ['needs-you', 'ready', 'yours', 'reviewing', 'merged']

export const PR_GROUP_LABEL: Record<PrGroupId, string> = {
  'needs-you': 'Needs you',
  ready: 'Ready to merge',
  yours: 'Your pull requests',
  reviewing: 'Reviewing',
  merged: 'Merged this week',
}

export const MERGED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Row icon. The renderer maps each to one glyph and one tone. */
export type PrRowIcon =
  | 'conflict'
  | 'failed'
  | 'review'
  | 'conversation'
  | 'running'
  | 'waiting'
  | 'ready'
  | 'merged'
  | 'draft'

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

/** Someone else's open PR: what you did on it, else how its approvals stand. */
function viewerPhrase(pr: PrSummary): string {
  if (pr.viewer.hasReviewed) return 'you reviewed'
  if (pr.viewer.hasCommented) return 'you commented'
  return approvalsPhrase(pr)
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
    if (pr.mergeConflicts) return { group: 'reviewing', icon: 'conflict', phrase: 'merge conflicts' }
    if (pr.checks.state === 'pending') return { group: 'reviewing', icon: 'running', phrase: 'checks running' }
    return { group: 'reviewing', icon: 'waiting', phrase: viewerPhrase(pr) }
  }

  if (pr.draft) return { group: 'yours', icon: 'draft', phrase: 'draft' }
  // Nothing else merges until the conflicts go, so they outrank a failed build.
  if (pr.mergeConflicts) return { group: 'needs-you', icon: 'conflict', phrase: 'merge conflicts' }
  if (pr.checks.state === 'failure') return { group: 'needs-you', icon: 'failed', phrase: 'build failed' }
  const open = pr.unresolvedConversations ?? 0
  if (open > 0) return { group: 'needs-you', icon: 'conversation', phrase: plural(open, 'open conversation') }
  if (pr.reviewers.some((r) => r.state === 'changes_requested')) {
    return { group: 'needs-you', icon: 'conversation', phrase: 'changes requested' }
  }
  if (pr.checks.state === 'pending') return { group: 'yours', icon: 'running', phrase: 'checks running' }
  const { given, required } = pr.approvals
  const approved = required !== null ? given >= required : given > 0
  if (approved && mergeBlockers(pr).length === 0) return { group: 'ready', icon: 'ready', phrase: '' }
  return { group: 'yours', icon: 'waiting', phrase: approvalsPhrase(pr) }
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
    const at = (pr: PrSummary) => (id === 'merged' ? (pr.mergedAt ?? 0) : pr.updatedAt)
    list.sort((a, b) => at(b.pr) - at(a.pr))
    out.push({ id, label: PR_GROUP_LABEL[id], prs: list })
  }
  return out
}

export type PrGroupBy = 'status' | 'repository'

export interface PrRepoSection {
  /** `repoKey`, which the collapsed setting stores. */
  key: string
  label: string
  /** Listed rows in the repository, status order. */
  count: number
  collapsed: boolean
  /** Rows to draw: none while collapsed, unless a filter is typed (matches always show). */
  prs: PrGroup['prs']
}

/**
 * By repository: one section per repository with its rows in the status
 * order (needs you first, then as `groupPullRequests`). Sections keep the
 * order of their first row, so the repository that needs you most comes
 * first.
 */
export function groupPullRequestsByRepo(
  prs: readonly PrSummary[],
  now: number,
  collapsed: readonly string[],
  filtering: boolean,
): PrRepoSection[] {
  const sections = new Map<string, PrGroup['prs']>()
  for (const group of groupPullRequests(prs, now)) {
    for (const row of group.prs) {
      const key = repoKey(row.pr.ref)
      const list = sections.get(key) ?? []
      list.push(row)
      sections.set(key, list)
    }
  }
  return [...sections].map(([key, rows]) => {
    const isCollapsed = collapsed.includes(key)
    const { owner, name } = rows[0].pr.ref
    return {
      key,
      label: `${owner} / ${name}`,
      count: rows.length,
      collapsed: isCollapsed,
      prs: isCollapsed && !filtering ? [] : rows,
    }
  })
}

export function toggleCollapsed(collapsed: readonly string[], key: string): string[] {
  return collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key]
}

/**
 * A hidden PR comes back on its own once it changed after it was hidden AND
 * it needs you now (its row is in Needs you: your review was asked for, your
 * build failed, a conversation or conflict is on you). Anything else keeps it
 * hidden; the user can always Show it. Coming back clears the hide, so it
 * does not vanish again when it stops needing you.
 */
export function hiddenComesBack(pr: PrSummary, hiddenAt: number, now: number): boolean {
  return pr.updatedAt > hiddenAt && prRowStatus(pr, now)?.group === 'needs-you'
}

/** Case-insensitive filter over title, repo, number and author. */
export function filterPullRequests<T extends PrSummary>(prs: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase().replace(/^#/, '')
  if (!q) return [...prs]
  return prs.filter((pr) =>
    [
      pr.title,
      pr.ref.name,
      pr.ref.owner,
      String(pr.ref.number),
      pr.author.login,
      pr.author.displayName,
      pr.sourceBranch,
    ].some((field) => field.toLowerCase().includes(q)),
  )
}

/** Splits the stored hides for one list read: the keys still hidden, and the ones whose PR came back (to clear). */
export function applyHidden(
  prs: readonly PrSummary[],
  hiddenAt: ReadonlyMap<string, number>,
  now: number,
): { hidden: string[]; cameBack: string[] } {
  const hidden: string[] = []
  const cameBack: string[] = []
  for (const pr of prs) {
    const key = prKey(pr.ref)
    const at = hiddenAt.get(key)
    if (at === undefined) continue
    if (hiddenComesBack(pr, at, now)) cameBack.push(key)
    else hidden.push(key)
  }
  return { hidden, cameBack }
}
