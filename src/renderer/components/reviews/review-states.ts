/**
 * Reviews copy that depends on state: the empty and error lines (one line
 * and one fix each), per-host notices above the list, and short times.
 * Pure, so the rules are tested without rendering.
 */
import { MERGE_STRATEGY_LABEL } from '@shared/pull-request-writes'
import { groupRepoFailures, isHideableRepoError, type RepoFailureGroup } from '@shared/pull-request-hidden-repos'
import { HOST_CAPABILITIES, PR_HOST_LABEL, type MergeStrategy, type PrCheck, type PrError, type PrListData, type PrSummary, type RepoRef } from '@shared/pull-requests'

export type ReviewFixAction = 'settings' | 'retry' | 'hide-repos' | null

export interface ReviewNotice {
  id: string
  line: string
  fix: string
  action: ReviewFixAction
  actionLabel?: string
  /** `hide-repos`: the repositories the card names. */
  repos?: RepoRef[]
}

function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function describePrError(error: PrError): ReviewNotice {
  const host = error.host ? PR_HOST_LABEL[error.host] : 'The host'
  const id = `${error.host ?? 'any'}:${error.kind}`
  switch (error.kind) {
    case 'no_account':
      return { id, line: `${host} pull requests need a source control account.`, fix: 'Add your Atlassian email and API token in Settings.', action: 'settings', actionLabel: 'Open Settings' }
    case 'needs_desktop':
      return { id, line: 'Bitbucket needs the desktop app in this release.', fix: 'Connect to this backend from the desktop app, which keeps the token in the keychain.', action: null }
    case 'token_rejected':
      return error.host === 'github'
        ? { id, line: 'gh is signed out, or GitHub rejected its token.', fix: 'Run gh auth login in a terminal, then retry.', action: 'retry', actionLabel: 'Retry' }
        : { id, line: `${host} rejected the API token.`, fix: error.message.includes('scope') ? error.message : 'Create a new API token and save it in Settings.', action: 'settings', actionLabel: 'Open Settings' }
    case 'gh_missing':
      return { id, line: 'GitHub pull requests need the gh CLI where the backend runs.', fix: 'Install it (brew install gh), run gh auth login, then retry.', action: 'retry', actionLabel: 'Retry' }
    case 'rate_limited':
      return { id, line: `${host} is rate limiting requests${error.retryAt ? ` until ${clock(error.retryAt)}` : ''}.`, fix: 'Reviews tries again on its next refresh.', action: 'retry', actionLabel: 'Retry' }
    case 'offline':
      return { id, line: `Could not reach ${error.host === 'bitbucket' ? 'bitbucket.org' : error.host === 'github' ? 'github.com' : 'the host'}.`, fix: 'Check the connection, then retry.', action: 'retry', actionLabel: 'Retry' }
    case 'unsupported_repo':
      return { id, line: 'This repository is not on GitHub or Bitbucket Cloud.', fix: 'Reviews reads pull requests from github.com and bitbucket.org remotes.', action: null }
    case 'not_found':
      return { id, line: error.message, fix: 'Check that this account can see the repository.', action: 'retry', actionLabel: 'Retry' }
    case 'forbidden':
      return { id, line: error.message, fix: `${host} did not allow it for this account.`, action: null }
    case 'conflict':
      return { id, line: error.message, fix: `Open the pull request in ${host} to see what blocks it.`, action: 'retry', actionLabel: 'Retry' }
    case 'stale':
      return { id, line: error.message, fix: 'Reviews refreshed the pull request; check it and try again.', action: 'retry', actionLabel: 'Retry' }
    case 'invalid':
      return { id, line: error.message, fix: 'Nothing was sent.', action: null }
    case 'unknown':
      return { id, line: error.message, fix: 'Retry, or check the log for details.', action: 'retry', actionLabel: 'Retry' }
  }
}

/** Names past this many per owner collapse into "and N more". */
const NAMES_PER_OWNER = 6

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * One card for the repositories a host could not read for one reason:
 * "Cannot see 3 repositories in geoiq-staging: a, b, c", every owner named,
 * and one line saying what to do, with a button that hides them.
 */
export function describeRepoFailures(group: RepoFailureGroup): ReviewNotice {
  const verb = group.kind === 'forbidden' ? 'Not allowed to read' : 'Cannot see'
  const owners = group.owners.map((o, i) => {
    const shown = o.names.slice(0, NAMES_PER_OWNER).join(', ')
    const more = o.names.length > NAMES_PER_OWNER ? ` and ${o.names.length - NAMES_PER_OWNER} more` : ''
    const count = i === 0 ? plural(o.names.length, 'repository', 'repositories') : String(o.names.length)
    return `${count} in ${o.owner}: ${shown}${more}`
  })
  const place = group.host === 'bitbucket' ? 'workspace' : 'owner'
  const that = group.owners.length === 1 ? `that ${place}` : `those ${place}s`
  const these = group.repos.length === 1 ? 'this repository' : 'these repositories'
  const account = group.host === 'bitbucket' ? "The API token's account" : 'The gh account'
  const fix = group.kind === 'forbidden'
    ? `${PR_HOST_LABEL[group.host]} refused this account for ${that} (SSO or an IP allow list); authorize it, or hide ${these}.`
    : `${account} needs access to ${that}, or hide ${these}.`
  return {
    id: `${group.host}:${group.kind}`,
    line: `${verb} ${owners.join('; ')}.`,
    fix,
    action: 'hide-repos',
    actionLabel: group.repos.length === 1 ? 'Hide this repository' : 'Hide these repositories',
    repos: group.repos,
  }
}

/** The confirm before hiding repositories names them and says how to bring them back. */
export function hideReposConfirmCopy(repos: readonly RepoRef[]): { title: string; body: string; confirmLabel: string } {
  const names = repos.map((r) => `${r.owner}/${r.name}`).join(', ')
  const hosts = [...new Set(repos.map((r) => PR_HOST_LABEL[r.host]))].join(' or ')
  return {
    title: repos.length === 1 ? 'Hide this repository from Reviews?' : `Hide ${repos.length} repositories from Reviews?`,
    body: `Reviews stops reading ${names}. Nothing changes on ${hosts}. Show ${repos.length === 1 ? 'it' : 'them'} again from the hidden line under the list.`,
    confirmLabel: 'Hide',
  }
}

/** The line under the list: "3 repositories hidden". */
export function hiddenReposLabel(count: number): string {
  return `${plural(count, 'repository', 'repositories')} hidden`
}

/**
 * The repositories the "N repositories hidden · Show" line offers back. Every
 * state but loading: once the rest fail (one blocking notice, or the list
 * read itself), this line is the only way back to a hidden repository. The
 * PR hidden line needs no such rule: a list blocked by its sources has no PRs.
 */
export function restorableHiddenRepos(state: ReviewListState, list: PrListData | null): RepoRef[] {
  if (state.kind === 'loading') return []
  return list?.hiddenRepos ?? []
}

/** One line under a write control that failed: the reason, and for account or network trouble, the fix. */
export function writeErrorText(error: PrError): string {
  const notice = describePrError(error)
  if (error.kind === 'forbidden' || error.kind === 'conflict' || error.kind === 'stale' || error.kind === 'invalid' || error.kind === 'unknown') {
    return notice.line
  }
  return `${notice.line} ${notice.fix}`
}

/** The merge confirm names the target branch and the strategy, which is what cannot be undone. */
export function mergeConfirmCopy(pr: Pick<PrSummary, 'ref' | 'sourceBranch' | 'targetBranch' | 'title'>, strategy: MergeStrategy): { title: string; body: string; confirmLabel: string } {
  return {
    title: `Merge #${pr.ref.number} into ${pr.targetBranch}?`,
    body: `"${pr.title}" merges ${pr.sourceBranch} into ${pr.targetBranch} on ${PR_HOST_LABEL[pr.ref.host]}. Strategy: ${MERGE_STRATEGY_LABEL[strategy].toLowerCase()}. This cannot be undone from Switchboard.`,
    confirmLabel: 'Merge',
  }
}

/** "Conflicts with main in 2 files"; GitHub does not name the files, so there it stops at the branch. */
export function conflictPhrase(pr: Pick<PrSummary, 'targetBranch' | 'conflictedFiles'>): string {
  const n = pr.conflictedFiles.length
  return n > 0 ? `Conflicts with ${pr.targetBranch} in ${n} ${n === 1 ? 'file' : 'files'}` : `Conflicts with ${pr.targetBranch}`
}

/** The decline / close confirm names the PR and says it changes it for everyone. */
export function declineConfirmCopy(pr: Pick<PrSummary, 'ref' | 'title'>): { title: string; body: string; confirmLabel: string; destructive: true } {
  const host = PR_HOST_LABEL[pr.ref.host]
  const verb = HOST_CAPABILITIES[pr.ref.host].declineLabel
  return {
    title: `${verb} #${pr.ref.number}?`,
    body: `"${pr.title}" is ${verb === 'Close' ? 'closed' : 'declined'} on ${host} for everyone: the author, the reviewers and anyone watching it. Nothing is merged. This cannot be undone from Switchboard.`,
    confirmLabel: verb,
    destructive: true,
  }
}

/** The whole list is one state: loading, an error, nothing to read, or rows (maybe with notices). */
export type ReviewListState =
  | { kind: 'loading' }
  | { kind: 'blocked'; notice: ReviewNotice }
  | { kind: 'ready'; notices: ReviewNotice[] }

export function reviewListState(data: PrListData | null, error: PrError | null): ReviewListState {
  if (error) return { kind: 'blocked', notice: describePrError(error) }
  if (!data) return { kind: 'loading' }
  if (data.sources.length === 0) {
    // Every repository is hidden: the list is empty on purpose, and the hidden line brings them back.
    if ((data.hiddenRepos?.length ?? 0) > 0) return { kind: 'ready', notices: [] }
    return {
      kind: 'blocked',
      notice: data.unsupportedProjects.length === 0
        ? { id: 'no-projects', line: 'No projects yet.', fix: 'Add a project whose git remote is on GitHub or Bitbucket.', action: null }
        : { id: 'unsupported', line: 'None of your projects has a GitHub or Bitbucket remote.', fix: 'Add one with git remote add origin <url>, then retry.', action: 'retry', actionLabel: 'Retry' },
    }
  }
  // One notice per host and reason, however many repositories share it. A
  // repository the account cannot see is named, so the user can hide it.
  const notices = new Map<string, ReviewNotice>()
  for (const source of data.sources) {
    if (!source.error || isHideableRepoError(source.error)) continue
    const notice = describePrError(source.error)
    if (!notices.has(notice.id)) notices.set(notice.id, notice)
  }
  for (const group of groupRepoFailures(data.sources)) {
    const notice = describeRepoFailures(group)
    notices.set(notice.id, notice)
  }
  const failedAll = data.sources.every((s) => s.error)
  if (failedAll && notices.size === 1 && data.prs.length === 0) return { kind: 'blocked', notice: [...notices.values()][0] }
  return { kind: 'ready', notices: [...notices.values()] }
}

/** "40 m", "3 h", "2 d": the mock's compact times. */
export function shortAgo(at: number, now: number): string {
  const mins = Math.max(0, Math.floor((now - at) / 60_000))
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins} m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} h`
  return `${Math.floor(hours / 24)} d`
}

/** "3 h ago", "2 days ago". */
export function agoPhrase(at: number, now: number): string {
  const mins = Math.max(0, Math.floor((now - at) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

/** The row's second line: repo · #number · phrase (merged rows say when). */
export function rowSubtitle(pr: PrSummary, phrase: string, now: number): string {
  const parts = [pr.ref.name, `#${pr.ref.number}`]
  if (pr.state === 'merged' && pr.mergedAt !== null) parts.push(agoPhrase(pr.mergedAt, now))
  else if (phrase) parts.push(phrase)
  return parts.join(' · ')
}

export interface FileGroup<T extends { path: string }> {
  dir: string
  files: T[]
}

/** The Files tab's tree: one level of directory headers, in first-seen order, root files last under "./". */
export function groupFilesByDir<T extends { path: string }>(files: readonly T[]): FileGroup<T>[] {
  const groups = new Map<string, T[]>()
  for (const file of files) {
    const cut = file.path.lastIndexOf('/')
    const dir = cut < 0 ? './' : `${file.path.slice(0, cut)}/`
    const list = groups.get(dir) ?? []
    list.push(file)
    groups.set(dir, list)
  }
  const out = [...groups].map(([dir, list]) => ({ dir, files: list }))
  return [...out.filter((g) => g.dir !== './'), ...out.filter((g) => g.dir === './')]
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Why a failed check has no Re-run, or `null` when it has one. */
export function rerunUnavailable(pr: Pick<PrSummary, 'ref'>, check: Pick<PrCheck, 'rerunId'>): string | null {
  const caps = HOST_CAPABILITIES[pr.ref.host]
  if (!caps.rerunChecks) return caps.rerunUnavailable
  if (!check.rerunId) return 'Only GitHub Actions runs re-run from here. Re-run this check where it ran.'
  return null
}
