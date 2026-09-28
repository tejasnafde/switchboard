/**
 * Pull request review data, neutral across hosts.
 *
 * GitHub (through the `gh` CLI) and Bitbucket Cloud (REST 2.0) map their own
 * JSON into these types in `main/pull-requests/*-map.ts`; the renderer and
 * the phone read only these. A field one host cannot supply is `null`, and
 * `HOST_CAPABILITIES` says which features a host has at all, so the UI can
 * tell "zero" from "unknown".
 *
 * The human write actions (reply, resolve, comment, review, merge, re-run,
 * reviewers, decline) take the inputs in `pull-request-writes.ts`.
 */

export type PrHost = 'github' | 'bitbucket'

export const PR_HOST_LABEL: Record<PrHost, string> = {
  github: 'GitHub',
  bitbucket: 'Bitbucket',
}

/** A repository on a host. `owner` is the GitHub owner or the Bitbucket workspace. */
export interface RepoRef {
  host: PrHost
  owner: string
  name: string
}

export interface PrRef extends RepoRef {
  number: number
}

export function repoKey(repo: RepoRef): string {
  return `${repo.host}:${repo.owner}/${repo.name}`.toLowerCase()
}

export function prKey(ref: PrRef): string {
  return `${repoKey(ref)}#${ref.number}`
}

export interface PrPerson {
  /** GitHub login, Bitbucket nickname. */
  login: string
  displayName: string
  avatarUrl: string | null
}

export type PrState = 'open' | 'merged' | 'closed'

export type ReviewState = 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending'

export interface PrReviewer {
  /** What the reviewer writes send: a GitHub login or `team:<slug>`, a Bitbucket account uuid. `null` when the host gave none (a deleted account). */
  id: string | null
  person: PrPerson
  state: ReviewState
  /** Asked to review. A reviewer who only commented unasked is `false`. */
  requested: boolean
}

/** Someone the Reviewers card offers to add. */
export interface PrReviewerCandidate {
  id: string
  person: PrPerson
  kind: 'user' | 'team'
  /** Listed pull requests of this repository they reviewed; 0 for a member who has not. */
  reviewed: number
}

export type CheckState = 'success' | 'failure' | 'pending' | 'skipped' | 'neutral'

export interface PrCheck {
  id: string
  name: string
  state: CheckState
  description: string | null
  url: string | null
  durationMs: number | null
  /** What the host re-runs (a GitHub Actions run id); `null` when this check cannot be re-run from here. */
  rerunId: string | null
}

export interface ChecksRollup {
  /** Worst state wins: any failure, then any pending, then success. `none` = no checks reported. */
  state: 'success' | 'failure' | 'pending' | 'none'
  total: number
  passed: number
  failed: number
  pending: number
}

export interface PrViewer {
  isAuthor: boolean
  /** Asked to review and has not submitted a review since. */
  isRequestedReviewer: boolean
  hasReviewed: boolean
}

export interface PrSummary {
  ref: PrRef
  title: string
  url: string
  author: PrPerson
  /** The author as a reviewer id (`PrReviewer.id`): the GitHub login, the Bitbucket account uuid. `null` when the host gave none. */
  authorId: string | null
  state: PrState
  draft: boolean
  sourceBranch: string
  targetBranch: string
  createdAt: number
  updatedAt: number
  mergedAt: number | null
  additions: number | null
  deletions: number | null
  changedFiles: number | null
  /** Open review conversations, `null` when the host did not say. */
  unresolvedConversations: number | null
  /** Conflicts with the target branch; `null` while the host has not worked it out. Always `false` once merged or closed. */
  mergeConflicts: boolean | null
  /** The conflicted paths when the host names them (Bitbucket's pull request conflicts endpoint). GitHub never does, so this is empty there. */
  conflictedFiles: string[]
  checks: ChecksRollup
  reviewers: PrReviewer[]
  approvals: { given: number; required: number | null }
  viewer: PrViewer
  /** Local projects whose remotes point at this repository. */
  projectPaths: string[]
}

export type MergeBlockerKind =
  | 'checks_failed'
  | 'checks_pending'
  | 'unresolved_conversations'
  | 'approvals_missing'
  | 'changes_requested'
  | 'conflicts'
  | 'draft'

export interface MergeBlocker {
  kind: MergeBlockerKind
  label: string
}

export type PrActivityKind = 'reviewed' | 'commented' | 'pushed' | 'merged' | 'opened'

export interface PrActivity {
  id: string
  kind: PrActivityKind
  actor: PrPerson | null
  /** Short phrase after the actor: "approved", "requested changes", "pushed 3 commits". */
  summary: string
  detail: string | null
  at: number
}

export interface PrDetail extends PrSummary {
  /** Markdown. HTML comments are already stripped. */
  description: string
  headSha: string | null
  mergeBlockers: MergeBlocker[]
  /** Strategies the repository allows, merge commit first (`orderMergeStrategies`). */
  mergeStrategies: MergeStrategy[]
  activity: PrActivity[]
  checkList: PrCheck[]
  /** The host lets you change the reviewers and decline or close it: the author, or write access to the repository (GitHub `viewerPermission`, Bitbucket `/user/workspaces/{ws}/permissions/repositories`). */
  viewerCanManage: boolean
}

/** Neutral names; each host maps its own. GitHub has the first three. */
export type MergeStrategy = 'merge_commit' | 'squash' | 'rebase' | 'fast_forward' | 'squash_fast_forward' | 'rebase_merge'

export interface PrComment {
  id: string
  author: PrPerson
  body: string
  createdAt: number
  url: string | null
}

export interface PrConversation {
  id: string
  /** `null` for a conversation on the whole pull request. */
  path: string | null
  /** Line on the side below; `null` when the host anchored it to the file or it is outdated. */
  line: number | null
  /** The first line when the conversation covers several (on `side`, ending at `line`); absent for one line. */
  startLine?: number
  side: 'new' | 'old' | null
  resolved: boolean
  outdated: boolean
  comments: PrComment[]
}

export type DiffLineKind = 'context' | 'add' | 'del'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  oldLine: number | null
  newLine: number | null
}

export interface DiffHunk {
  header: string
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

export type ChangedFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'conflicted'

export interface PrChangedFile {
  path: string
  oldPath: string | null
  status: ChangedFileStatus
  additions: number
  deletions: number
  binary: boolean
  /** The host or Switchboard cut the patch short; the full diff is on the host. */
  truncated: boolean
  hunks: DiffHunk[]
}

export interface HostCapabilities {
  /** The required approval count is read (GitHub branch protection). Otherwise `approvals.required` is always `null`. */
  requiredApprovals: boolean
  /** Check durations come from the check itself, not from when its status was first and last posted. */
  exactCheckDurations: boolean
  /** Failed checks can be re-run from Switchboard. When `false`, `rerunUnavailable` says why. */
  rerunChecks: boolean
  rerunUnavailable: string | null
  /** Offers teams as reviewers (GitHub organisation teams). */
  teamReviewers: boolean
  /** What declining is called on the host: Bitbucket declines, GitHub closes. */
  declineLabel: 'Decline' | 'Close'
}

/**
 * Conversations are inline review threads on both hosts; comments on the
 * whole pull request show in Activity.
 */
export const HOST_CAPABILITIES: Record<PrHost, HostCapabilities> = {
  // Only GitHub Actions runs re-run; a check from another app has `rerunId: null`.
  github: { requiredApprovals: true, exactCheckDurations: true, rerunChecks: true, rerunUnavailable: null, teamReviewers: true, declineLabel: 'Close' },
  // Bitbucket branch restrictions need repository admin to read. Its REST API
  // can start a new pipeline but has no re-run of a failed one.
  bitbucket: {
    requiredApprovals: false,
    exactCheckDurations: false,
    rerunChecks: false,
    rerunUnavailable: "Bitbucket's API cannot re-run a pipeline. Re-run it on bitbucket.org from the check's Details.",
    teamReviewers: false,
    declineLabel: 'Decline',
  },
}

export type PrErrorKind =
  | 'no_account'
  | 'unsupported_repo'
  | 'token_rejected'
  | 'rate_limited'
  | 'offline'
  | 'needs_desktop'
  | 'gh_missing'
  | 'not_found'
  /** Writes: the host or the account does not allow this (your own PR, missing permission). */
  | 'forbidden'
  /** Writes: the host refused because of the PR's state (not mergeable, a pending review already open). */
  | 'conflict'
  /** Writes: the PR changed since it was shown (new head, a blocker appeared, the thread is gone). */
  | 'stale'
  /** Writes: the input was refused before anything was sent. */
  | 'invalid'
  | 'unknown'

export interface PrError {
  kind: PrErrorKind
  host: PrHost | null
  message: string
  /** Rate limits: when the host says to try again. */
  retryAt?: number
  /** A review that failed part way (Bitbucket posts comments one by one): how many pending comments were posted. */
  postedComments?: number
}

export type PrResult<T> = { ok: true; data: T } | { ok: false; error: PrError }

/** One repository the list looked at, and whether it could be read. */
export interface PrSource {
  repo: RepoRef
  projectPaths: string[]
  error: PrError | null
}

export interface PrListData {
  prs: PrSummary[]
  sources: PrSource[]
  /** Projects with no GitHub or Bitbucket remote. */
  unsupportedProjects: string[]
  fetchedAt: number
  /** `prKey`s the user hid from Reviews (local only, `pull-request-groups.ts` says when one comes back). */
  hidden: string[]
}

// ─── Source control accounts ──────────────────────────────────────

export type BitbucketAccountState =
  | { state: 'unconfigured' }
  | { state: 'configured'; email: string }
  | { state: 'needs_desktop' }

export type GithubAccountState =
  | { state: 'signed_in'; login: string }
  | { state: 'signed_out' }
  | { state: 'gh_missing' }
  | { state: 'unknown'; message: string }

export interface SourceControlStatus {
  bitbucket: BitbucketAccountState
  github: GithubAccountState
}

export interface BitbucketCredentialInput {
  email: string
  apiToken: string
}

export interface SourceControlTestResult {
  ok: boolean
  message: string
}

/**
 * The Atlassian API token scopes the Bitbucket provider needs: `/user`, the
 * repository and its commit statuses, the pull request reads, and the human
 * writes (comments, resolve, approve, request changes, merge, reviewers,
 * decline). read:repository also covers the repository permission read that
 * decides who may decline or edit a PR. It calls no Pipelines endpoint, so it
 * needs no pipeline scope. read:workspace is optional: without it Add
 * reviewer offers recent reviewers only, not workspace members.
 */
export const BITBUCKET_READ_SCOPES = ['read:user:bitbucket', 'read:repository:bitbucket', 'read:pullrequest:bitbucket'] as const
export const BITBUCKET_TOKEN_SCOPES = [...BITBUCKET_READ_SCOPES, 'write:pullrequest:bitbucket'] as const
export const BITBUCKET_OPTIONAL_SCOPES = ['read:workspace:bitbucket'] as const

// ─── Pure helpers ─────────────────────────────────────────────────

export function rollupChecks(checks: readonly Pick<PrCheck, 'state'>[]): ChecksRollup {
  let passed = 0
  let failed = 0
  let pending = 0
  for (const c of checks) {
    if (c.state === 'failure') failed++
    else if (c.state === 'pending') pending++
    else passed++
  }
  const total = checks.length
  const state = total === 0 ? 'none' : failed > 0 ? 'failure' : pending > 0 ? 'pending' : 'success'
  return { state, total, passed, failed, pending }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Why a pull request cannot merge yet, in the order the Merge card lists them. */
export function mergeBlockers(pr: PrSummary): MergeBlocker[] {
  const out: MergeBlocker[] = []
  if (pr.state !== 'open') return out
  if (pr.draft) out.push({ kind: 'draft', label: 'Draft' })
  if (pr.mergeConflicts) out.push({ kind: 'conflicts', label: `Conflicts with ${pr.targetBranch}` })
  if (pr.checks.state === 'failure') {
    out.push({ kind: 'checks_failed', label: pr.checks.failed === 1 ? '1 check failed' : `${pr.checks.failed} checks failed` })
  } else if (pr.checks.state === 'pending') {
    out.push({ kind: 'checks_pending', label: 'Checks running' })
  }
  if ((pr.unresolvedConversations ?? 0) > 0) {
    out.push({ kind: 'unresolved_conversations', label: `${plural(pr.unresolvedConversations ?? 0, 'unresolved conversation')}` })
  }
  if (pr.reviewers.some((r) => r.state === 'changes_requested')) {
    out.push({ kind: 'changes_requested', label: 'Changes requested' })
  }
  const { given, required } = pr.approvals
  if (required !== null && given < required) {
    out.push({ kind: 'approvals_missing', label: `${given} of ${required} required approvals` })
  }
  return out
}

/** Strip HTML comments (bot fingerprints, templates), which the markdown renderer would show escaped. */
export function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim()
}
