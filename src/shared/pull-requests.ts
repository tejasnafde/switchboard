/**
 * Pull request review data, neutral across hosts.
 *
 * GitHub (through the `gh` CLI) and Bitbucket Cloud (REST 2.0) map their own
 * JSON into these types in `main/pull-requests/*-map.ts`; the renderer and
 * the phone read only these. A field one host cannot supply is `null`, and
 * `HOST_CAPABILITIES` says which features a host has at all, so the UI can
 * tell "zero" from "unknown".
 *
 * Read-only in this release: nothing here describes a write.
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
  person: PrPerson
  state: ReviewState
  /** Asked to review. A reviewer who only commented unasked is `false`. */
  requested: boolean
}

export type CheckState = 'success' | 'failure' | 'pending' | 'skipped' | 'neutral'

export interface PrCheck {
  id: string
  name: string
  state: CheckState
  description: string | null
  url: string | null
  durationMs: number | null
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
  activity: PrActivity[]
  checkList: PrCheck[]
}

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

export type ChangedFileStatus = 'added' | 'modified' | 'deleted' | 'renamed'

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
}

/**
 * Conversations are inline review threads on both hosts; comments on the
 * whole pull request show in Activity.
 */
export const HOST_CAPABILITIES: Record<PrHost, HostCapabilities> = {
  github: { requiredApprovals: true, exactCheckDurations: true },
  // Bitbucket branch restrictions need repository admin to read.
  bitbucket: { requiredApprovals: false, exactCheckDurations: false },
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
  | 'unknown'

export interface PrError {
  kind: PrErrorKind
  host: PrHost | null
  message: string
  /** Rate limits: when the host says to try again. */
  retryAt?: number
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
  /** Workspaces the account can see, with how many repositories in each. */
  workspaces?: Array<{ name: string; repositories: number }>
}

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
export function mergeBlockers(pr: PrSummary, opts: { conflicts?: boolean } = {}): MergeBlocker[] {
  const out: MergeBlocker[] = []
  if (pr.state !== 'open') return out
  if (pr.draft) out.push({ kind: 'draft', label: 'Draft' })
  if (opts.conflicts) out.push({ kind: 'conflicts', label: 'Merge conflicts' })
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
