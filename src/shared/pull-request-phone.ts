/**
 * The phones' Reviews tab: filters, the badge, the PR detail's status card
 * and "Work on PR". Read-only: a phone calls no `PullRequestWriteChannels`
 * channel. Grouping is `pull-request-groups.ts`, the desktop's rule.
 *
 * Android ports these functions; both run `tests/fixtures/phone-pr-cases.json`.
 */
import { filterPullRequests, groupPullRequests, prRowStatus, type PrRowStatus } from './pull-request-groups'
import {
  PR_HOST_LABEL,
  prKey,
  repoKey,
  type ChecksRollup,
  type PrCheck,
  type PrDetail,
  type PrHost,
  type PrSource,
  type PrSummary,
} from './pull-requests'
import { checkItem, conflictsItem, expandReviewContext, reviewContextLabel, type ReviewContext } from './review-context'
import type { UserMessagePillsMeta } from './provider-events'
import type { WorktreeExistingBranchIntent } from './worktree-creation'

/** The backend capability "Work on PR" needs to start a chat in a worktree on the PR's branch (`checkout.existingBranch`). */
export const WORK_ON_PR_CAPABILITY = 'worktree_existing_branch_v1'

export type PhonePrShow = 'all' | 'needs-you' | 'mine' | 'reviewing'
export type PhonePrChecks = 'any' | 'failing' | 'running' | 'passing'

export interface PhonePrFilters {
  show: PhonePrShow
  groupBy: 'status' | 'repository'
  checks: PhonePrChecks
  /** `repoKey`s left out of the list. */
  excludedRepos: string[]
  showDrafts: boolean
  showHidden: boolean
}

export const DEFAULT_PHONE_PR_FILTERS: PhonePrFilters = {
  show: 'all',
  groupBy: 'status',
  checks: 'any',
  excludedRepos: [],
  showDrafts: true,
  showHidden: false,
}

/** The filter button carries a dot when the sheet holds anything but the defaults (the chips show `show` and `groupBy`). */
export function phonePrFiltersActive(f: PhonePrFilters): boolean {
  return f.checks !== 'any' || f.excludedRepos.length > 0 || !f.showDrafts || f.showHidden
}

function shows(pr: PrSummary, show: PhonePrShow, status: PrRowStatus): boolean {
  switch (show) {
    case 'all':
      return true
    case 'needs-you':
      return status.group === 'needs-you'
    case 'mine':
      return pr.viewer.isAuthor
    case 'reviewing':
      return !pr.viewer.isAuthor
  }
}

function checksMatch(pr: PrSummary, checks: PhonePrChecks): boolean {
  switch (checks) {
    case 'any':
      return true
    case 'failing':
      return pr.checks.state === 'failure'
    case 'running':
      return pr.checks.state === 'pending'
    case 'passing':
      return pr.checks.state === 'success'
  }
}

/** The listed PRs after the text filter and the sheet. Unlisted PRs (closed, old merges) never pass. */
export function filterPhonePrs(
  prs: readonly PrSummary[],
  hidden: readonly string[],
  f: PhonePrFilters,
  query: string,
  now: number,
): PrSummary[] {
  const hiddenKeys = new Set(hidden)
  const excluded = new Set(f.excludedRepos)
  return filterPullRequests(prs, query).filter((pr) => {
    const status = prRowStatus(pr, now)
    if (!status) return false
    if (!f.showHidden && hiddenKeys.has(prKey(pr.ref))) return false
    if (!f.showDrafts && pr.draft) return false
    if (excluded.has(repoKey(pr.ref))) return false
    return shows(pr, f.show, status) && checksMatch(pr, f.checks)
  })
}

/** The Reviews tab badge and the "Needs you" chip: listed, not hidden, in Needs you. */
export function needsYouCount(prs: readonly PrSummary[], hidden: readonly string[], now: number): number {
  const hiddenKeys = new Set(hidden)
  return prs.filter((pr) => !hiddenKeys.has(prKey(pr.ref)) && prRowStatus(pr, now)?.group === 'needs-you').length
}

export interface PhonePrSection {
  key: string
  title: string
  rows: Array<{ pr: PrSummary; status: PrRowStatus }>
}

/** Sections in display order: the desktop's status groups, or one per repository with rows in status order. */
export function phonePrSections(
  prs: readonly PrSummary[],
  groupBy: PhonePrFilters['groupBy'],
  now: number,
): PhonePrSection[] {
  const groups = groupPullRequests(prs, now)
  if (groupBy === 'status') return groups.map((g) => ({ key: g.id, title: g.label, rows: g.prs }))
  const sections = new Map<string, PhonePrSection>()
  for (const row of groups.flatMap((g) => g.prs)) {
    const key = repoKey(row.pr.ref)
    const section = sections.get(key) ?? { key, title: `${row.pr.ref.owner}/${row.pr.ref.name}`, rows: [] }
    section.rows.push(row)
    sections.set(key, section)
  }
  return [...sections.values()]
}

/** The repositories the filter sheet lists: every one with a listed PR, by name. */
export function phonePrRepos(prs: readonly PrSummary[]): Array<{ key: string; label: string }> {
  const repos = new Map<string, string>()
  for (const pr of prs) repos.set(repoKey(pr.ref), `${pr.ref.owner}/${pr.ref.name}`)
  return [...repos].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label))
}

export function toggleExcludedRepo(f: PhonePrFilters, key: string): PhonePrFilters {
  const excludedRepos = f.excludedRepos.includes(key)
    ? f.excludedRepos.filter((k) => k !== key)
    : [...f.excludedRepos, key]
  return { ...f, excludedRepos }
}

/** "now", "12m", "3h", "2d": how long ago a row was updated. */
export function prAgeLabel(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** The header subtitle after the machine name: "8 open", "nothing open", "showing Bitbucket only". */
export function phonePrSubtitle(listed: number, failedHosts: readonly PrHost[], readHosts: readonly PrHost[]): string {
  const working = readHosts.filter((h) => !failedHosts.includes(h))
  if (failedHosts.length > 0 && working.length === 1) return `showing ${PR_HOST_LABEL[working[0]]} only`
  return listed === 0 ? 'nothing open' : `${listed} open`
}

// ─── Errors ─────────────────────────────────────────────────────────

export interface PhonePrHostError {
  host: PrHost
  title: string
  message: string
}

/**
 * One card per host whose every repository failed with the same host-wide
 * problem (signed out, offline, rate limited). A repository the account
 * cannot see (`not_found`, `forbidden`) is the desktop's hide card, not this.
 */
export function phonePrHostErrors(sources: readonly PrSource[]): PhonePrHostError[] {
  const out: PhonePrHostError[] = []
  for (const host of ['github', 'bitbucket'] as const) {
    const mine = sources.filter((s) => s.repo.host === host)
    const first = mine[0]?.error
    if (!first || first.kind === 'not_found' || first.kind === 'forbidden') continue
    if (!mine.every((s) => s.error?.kind === first.kind)) continue
    out.push({ host, title: `Couldn't read ${PR_HOST_LABEL[host]}`, message: first.message })
  }
  return out
}

/** The hosts the list read at all, for the subtitle. */
export function phonePrHosts(sources: readonly PrSource[]): PrHost[] {
  return [...new Set(sources.map((s) => s.repo.host))]
}

// ─── Detail ─────────────────────────────────────────────────────────

export type PhonePrTone = 'failure' | 'pending' | 'success' | 'dim'

export interface PhonePrStatusLine {
  text: string
  tone: PhonePrTone
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export function checksStatus(c: ChecksRollup): PhonePrStatusLine {
  switch (c.state) {
    case 'failure':
      return { text: `${c.failed} of ${c.total} failed`, tone: 'failure' }
    case 'pending':
      return { text: `${c.pending} of ${c.total} running`, tone: 'pending' }
    case 'success':
      return { text: c.total === 1 ? 'Passed' : `All ${c.total} passed`, tone: 'success' }
    case 'none':
      return { text: 'None reported', tone: 'dim' }
  }
}

export function reviewsStatus(pr: PrSummary): PhonePrStatusLine {
  const changes = pr.reviewers.some((r) => r.state === 'changes_requested')
  const { given, required } = pr.approvals
  const approvals =
    required !== null && required > 0 ? `${given} of ${required} approvals` : given > 0 ? plural(given, 'approval') : ''
  const waiting = pr.reviewers.some((r) => r.requested && r.state === 'pending')
  const text = [
    changes && 'Changes requested',
    approvals || (!changes && (waiting ? 'Waiting for review' : 'No reviews')),
  ]
    .filter(Boolean)
    .join(' · ')
  const approved = required !== null ? given >= required && given > 0 : given > 0
  return { text, tone: changes ? 'pending' : approved ? 'success' : 'dim' }
}

export function conversationsStatus(pr: PrSummary): PhonePrStatusLine {
  const open = pr.unresolvedConversations
  if (open === null) return { text: 'Not reported', tone: 'dim' }
  return open > 0 ? { text: `${open} open`, tone: 'pending' } : { text: 'None open', tone: 'success' }
}

export function conflictsStatus(pr: PrSummary): PhonePrStatusLine {
  if (pr.mergeConflicts === null) return { text: 'Not checked yet', tone: 'dim' }
  if (!pr.mergeConflicts) return { text: `None with ${pr.targetBranch}`, tone: 'success' }
  const files = pr.conflictedFiles.length
  return { text: files > 0 ? plural(files, 'file') : `With ${pr.targetBranch}`, tone: 'failure' }
}

/** Checks shown before "+ N more passed" when the card is expanded. */
export const PHONE_CHECKS_SHOWN = 6

const CHECK_ORDER: Record<PrCheck['state'], number> = { failure: 0, pending: 1, success: 2, neutral: 3, skipped: 4 }

/** Failures first, then running, then the rest, each in the host's order. */
export function orderedChecks(checks: readonly PrCheck[]): PrCheck[] {
  return checks
    .map((check, index) => ({ check, index }))
    .sort((a, b) => CHECK_ORDER[a.check.state] - CHECK_ORDER[b.check.state] || a.index - b.index)
    .map(({ check }) => check)
}

/** "4m 12s", "48s", "1h 02m". */
export function checkDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** The right side of a check row: "failed · 4m 12s", "running", "1m 05s", "skipped". */
export function checkTrailing(check: PrCheck): string {
  const duration = check.durationMs !== null ? checkDuration(check.durationMs) : ''
  switch (check.state) {
    case 'failure':
      return duration ? `failed · ${duration}` : 'failed'
    case 'pending':
      return 'running'
    case 'skipped':
      return 'skipped'
    default:
      return duration
  }
}

/** The line under the shown checks: "+ 8 more passed", or "+ 3 more" when they are not all passes. */
export function moreChecksLabel(hidden: readonly PrCheck[]): string {
  if (hidden.length === 0) return ''
  return hidden.every((c) => c.state === 'success') ? `+ ${hidden.length} more passed` : `+ ${hidden.length} more`
}

/** "+184 -37 in 6 files", or '' when the host did not say. */
export function diffStatLabel(pr: PrSummary): string {
  if (pr.additions === null || pr.deletions === null) return ''
  const files = pr.changedFiles !== null ? ` in ${plural(pr.changedFiles, 'file')}` : ''
  return `+${pr.additions} -${pr.deletions}${files}`
}

/** Follows "Merge on desktop." where the Merge button would be. */
export function mergeOnDesktopNote(host: PrHost): string {
  return `Reviews, comments and merges post as you on ${PR_HOST_LABEL[host]}, so they stay on the desktop app.`
}

export const RERUN_ON_DESKTOP_NOTE = 'Re-run failed jobs on the desktop.'

// ─── Work on PR ─────────────────────────────────────────────────────

/**
 * The existing-branch checkout for a PR's head, fetched from the project's
 * remote for the PR's repository. A GitHub fork PR is fetched through
 * `refs/pull/<n>/head` into `pr-<n>`; a Bitbucket fork PR has no such ref on
 * the destination repository, so it gets `null` and the chat falls back to
 * asking the agent to check it out.
 */
export function workOnPrCheckout(pr: PrSummary): WorktreeExistingBranchIntent | null {
  const repo = { host: pr.ref.host, owner: pr.ref.owner, name: pr.ref.name }
  if (pr.headFromFork) {
    if (pr.ref.host !== 'github') return null
    return { name: `pr-${pr.ref.number}`, fetch: { repo, ref: `refs/pull/${pr.ref.number}/head` } }
  }
  return { name: pr.sourceBranch, fetch: { repo, ref: pr.sourceBranch } }
}

/** The shell command an agent runs to check the PR out itself. */
export function prCheckoutCommand(pr: PrSummary): string {
  return pr.ref.host === 'github' ? `gh pr checkout ${pr.ref.number}` : `bbpr ${pr.ref.number}`
}

export interface PhoneReviewPill {
  label: string
  /** What the agent reads in place of the pill. */
  content: string
}

/**
 * Where a "Work on PR" chat runs: a worktree on the PR's branch, the project
 * checkout (an older backend, a Bitbucket fork: the agent checks it out
 * first), or an existing chat the pill is attached to (no instruction).
 */
export type WorkOnPrPlace = 'worktree' | 'checkout' | 'attached'

/** The review pill a "Work on PR" chat starts with: the PR, its conflicts and failed checks. */
export function workOnPrPill(pr: PrDetail, place: WorkOnPrPlace): PhoneReviewPill {
  const ctx: ReviewContext = {
    pr: pr.ref,
    title: pr.title,
    url: pr.url,
    items: [
      ...(pr.mergeConflicts ? [conflictsItem(pr)] : []),
      ...pr.checkList.filter((c) => c.state === 'failure').map(checkItem),
    ],
  }
  const expansion = expandReviewContext(ctx)
  const where = {
    worktree: `This chat runs in a worktree on the pull request's branch (${pr.sourceBranch}).`,
    checkout: `Before anything else, check out the pull request: run \`${prCheckoutCommand(pr)}\` in this project, and stop and say so if that fails.`,
    attached: '',
  }[place]
  return { label: reviewContextLabel(ctx), content: where ? `${expansion}\n\n${where}` : expansion }
}

/**
 * A phone send that carries a review pill: the stored body shows the chip
 * (`[[pill:id]]` before the typed text, the desktop's draft order), the agent
 * reads the pill's content in its place.
 */
export function reviewPillTurn(
  text: string,
  pill: PhoneReviewPill,
  pillId: string,
): { displayBody: string; providerText: string; pillsMeta: UserMessagePillsMeta } {
  const body = text.trim()
  return {
    displayBody: body ? `[[pill:${pillId}]] ${body}` : `[[pill:${pillId}]]`,
    providerText: body ? `${pill.content}\n\n${body}` : pill.content,
    pillsMeta: { [pillId]: { label: pill.label, kind: 'review' } },
  }
}

/** "Ask the agent about the failures": the failed checks only. `null` when none failed. */
export function failedChecksPill(pr: PrDetail): PhoneReviewPill | null {
  const failed = pr.checkList.filter((c) => c.state === 'failure')
  if (failed.length === 0) return null
  const ctx: ReviewContext = { pr: pr.ref, title: pr.title, url: pr.url, items: failed.map(checkItem) }
  return { label: reviewContextLabel(ctx), content: expandReviewContext(ctx) }
}
