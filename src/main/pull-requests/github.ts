/**
 * GitHub through the `gh` CLI where the backend runs: `gh api graphql` for
 * pull requests, reviews, threads and checks, `gh api` (REST) for changed
 * files with their patches. gh holds the token; Switchboard never asks for
 * it, so nothing here can print one.
 *
 * Writes send their JSON body on stdin (`--input -`), never as `-F` fields,
 * which would read a body starting with `@` as a file name.
 */
import { execFile } from 'node:child_process'
import type { CreatedPr, CreatePrInput } from '@shared/agent-pr-create'
import type { InlineCommentInput, ReviewEvent, SubmitReviewInput } from '@shared/pull-request-writes'
import type { MergeStrategy, PrChangedFile, PrCheck, PrConversation, PrDetail, PrError, PrRef, PrReviewerCandidate, RepoRef } from '@shared/pull-requests'
import { repoKey } from '@shared/pull-requests'
import { childProcessEnv } from '../shell-env'
import { createMainLogger } from '../logger'
import {
  classifyGhError,
  classifyGhWriteError,
  GH_TIMED_OUT,
  isTransientGhFailure,
  mapGhCandidates,
  mapGhChecks,
  mapGhDetail,
  mapGhFiles,
  mapGhSummary,
  mapGhThreads,
  type GhCollaborator,
  type GhPullFile,
  type GhPullRequest,
  type GhPullRequestDetail,
  type GhRepoMergeSettings,
  type GhReviewThread,
  type GhTeam,
} from './github-map'
import { PrHostError, type PullRequestProvider, type RepoListResult } from './provider'

const log = createMainLogger('pull-requests:github')

export interface GhRunResult {
  stdout: string
  stderr: string
  /** Exit code, or the spawn error code (`ENOENT` when gh is missing). `0` on success. */
  code: number | string | null
}

/** `input` is written to gh's stdin (the request body of a `--input -` call). */
export type GhRunner = (args: string[], opts?: { input?: string }) => Promise<GhRunResult>

const GH_TIMEOUT_MS = 30_000
const OPEN_PER_REPO = 30
const MERGED_PER_REPO = 15
/**
 * Repositories per GraphQL request. Eight timed out (HTTP 504) on every
 * refresh for one user; a batch that still fails is split in half.
 */
const REPOS_PER_QUERY = 4
const MAX_FILE_PAGES = 3
/** Pause before the one retry of a read GitHub answered with a 5xx. */
const READ_RETRY_DELAY_MS = 1_000

export const defaultGhRunner: GhRunner = (args, opts = {}) =>
  new Promise((resolve) => {
    const child = execFile('gh', args, { env: childProcessEnv(), timeout: GH_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      // Killed for the timeout; a body over maxBuffer is killed too, but says so in its code.
      if (err?.killed && (err as NodeJS.ErrnoException).code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        resolve({ stdout: String(stdout), stderr: `${String(stderr)}\ngh did not answer within ${GH_TIMEOUT_MS / 1000}s`, code: GH_TIMED_OUT })
        return
      }
      const code = err ? ((err as NodeJS.ErrnoException).code ?? (err as { code?: number }).code ?? 1) : 0
      resolve({ stdout: String(stdout), stderr: String(stderr), code })
    })
    if (opts.input !== undefined) {
      child.stdin?.on('error', (err) => log.warn('writing to gh stdin failed', { err: String(err) }))
      child.stdin?.end(opts.input)
    }
  })

const MERGE_METHOD: Partial<Record<MergeStrategy, string>> = { merge_commit: 'merge', squash: 'squash', rebase: 'rebase' }
const REVIEW_EVENT: Record<ReviewEvent, string> = { comment: 'COMMENT', approve: 'APPROVE', request_changes: 'REQUEST_CHANGES' }

/** A line comment in the REST shape both `pulls/:n/comments` and `pulls/:n/reviews` take. */
export function ghLineComment(c: InlineCommentInput): Record<string, string | number> {
  const side = c.side === 'old' ? 'LEFT' : 'RIGHT'
  const out: Record<string, string | number> = { path: c.path, line: c.line, side, body: c.body }
  if (c.startLine !== undefined) {
    out.start_line = c.startLine
    out.start_side = side
  }
  return out
}

const REPLY_MUTATION = `mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id } }
}`
const RESOLVE_MUTATION = `mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { id isResolved } } }`
const UNRESOLVE_MUTATION = `mutation($thread: ID!) { unresolveReviewThread(input: { threadId: $thread }) { thread { id isResolved } } }`
const HEAD_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { headRefOid } }
}`

const PR_FIELDS = `
  number title url state isDraft createdAt updatedAt mergedAt mergeable
  headRefName baseRefName headRefOid additions deletions changedFiles
  author { login avatarUrl ... on User { name } }
  baseRef { branchProtectionRule { requiredApprovingReviewCount } }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login name avatarUrl } ... on Team { slug name } } } }
  latestReviews(first: 20) { nodes { state submittedAt author { login avatarUrl ... on User { name } } } }
  reviewThreads(first: 100) { totalCount nodes { isResolved } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 50) { nodes {
    __typename
    ... on CheckRun { name status conclusion startedAt completedAt detailsUrl }
    ... on StatusContext { context state targetUrl description createdAt }
  } } } } } }
`

/**
 * A merged row needs no mergeable (GitHub computes it on read), threads,
 * checks or review requests: only what says who took part.
 */
const MERGED_PR_FIELDS = `
  number title url state isDraft createdAt updatedAt mergedAt
  headRefName baseRefName additions deletions changedFiles
  author { login avatarUrl ... on User { name } }
  latestReviews(first: 20) { nodes { state author { login avatarUrl ... on User { name } } } }
`

export function buildListQuery(repos: readonly RepoRef[]): string {
  const blocks = repos.map((r, i) => `
  r${i}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.name)}) {
    open: pullRequests(states: OPEN, first: ${OPEN_PER_REPO}, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ...Pr } }
    merged: pullRequests(states: MERGED, first: ${MERGED_PER_REPO}, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ...MergedPr } }
  }`).join('')
  return `query {\n  viewer { login }${blocks}\n}\nfragment Pr on PullRequest {${PR_FIELDS}}\nfragment MergedPr on PullRequest {${MERGED_PR_FIELDS}}`
}

const DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) { mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerPermission pullRequest(number: $number) {
    ${PR_FIELDS}
    body
    timelineItems(last: 30, itemTypes: [PULL_REQUEST_REVIEW, ISSUE_COMMENT, MERGED_EVENT, PULL_REQUEST_COMMIT]) { nodes {
      __typename
      ... on PullRequestReview { state submittedAt author { login avatarUrl } comments { totalCount } }
      ... on IssueComment { createdAt body author { login avatarUrl } }
      ... on MergedEvent { createdAt actor { login avatarUrl } }
      ... on PullRequestCommit { commit { oid committedDate messageHeadline author { user { login avatarUrl } } } }
    } }
  } }
}`

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 100) { nodes {
      id isResolved isOutdated path line originalLine diffSide startLine startDiffSide
      comments(first: 50) { nodes { id body url createdAt author { login avatarUrl } } }
    } }
  } }
}`

const CHECKS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
      __typename
      ... on CheckRun { name status conclusion startedAt completedAt detailsUrl }
      ... on StatusContext { context state targetUrl description createdAt }
    } } } } } }
  } }
}`

interface GraphqlResponse<T> {
  data?: T | null
  errors?: Array<{ type?: string; message: string; path?: Array<string | number> }>
}

function parseJson<T>(text: string): T | null {
  if (!text.trim()) return null
  try {
    return JSON.parse(text) as T
  } catch (err) {
    log.warn('gh returned output that is not JSON', { bytes: text.length, err: String(err) })
    return null
  }
}

function graphqlArgs(query: string, vars: Record<string, string | number> = {}): string[] {
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [key, value] of Object.entries(vars)) {
    args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`)
  }
  return args
}

/**
 * gh's answer to a query: the body, or the classified error and whether it
 * is worth trying again (a server error, or a body cut short).
 */
function graphqlAnswer<T>(res: GhRunResult): { body: GraphqlResponse<T> } | { error: PrError; transient: boolean } {
  const body = parseJson<GraphqlResponse<T>>(res.stdout)
  if (res.code !== 0 && !body?.data) {
    const message = body?.errors?.map((e) => e.message).join('; ')
    return { error: classifyGhError({ ...res, stderr: `${res.stderr}\n${message ?? ''}` }), transient: isTransientGhFailure(res) }
  }
  // Exit 0 with no JSON is a body cut off in transit.
  if (!body) return { error: { kind: 'unknown', host: 'github', message: 'gh returned no data.' }, transient: res.code === 0 && res.stdout.trim() !== '' }
  return { body }
}

export class GitHubProvider implements PullRequestProvider {
  readonly host = 'github' as const

  constructor(
    private readonly run: GhRunner = defaultGhRunner,
    private readonly retryDelayMs = READ_RETRY_DELAY_MS,
  ) {}

  /** A read, tried once more after a pause when GitHub answered with a 5xx. Writes go through `run` directly. */
  private async read(args: string[]): Promise<GhRunResult> {
    const res = await this.run(args)
    if (!isTransientGhFailure(res)) return res
    log.warn('GitHub read failed with a server error, retrying once', { endpoint: args[1], stderr: res.stderr.trim().slice(0, 200) })
    await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs))
    return this.run(args)
  }

  /** The signed-in login, or the classified reason there is none. */
  async viewerLogin(): Promise<string> {
    const res = await this.read(['api', 'user', '--jq', '.login'])
    if (res.code !== 0) throw new PrHostError(classifyGhError(res))
    return res.stdout.trim()
  }

  /** Runs a query; a response carrying `data` is returned even when gh exits non-zero, so one missing repo does not sink the rest. */
  private async graphql<T>(query: string, vars: Record<string, string | number> = {}): Promise<GraphqlResponse<T>> {
    const res = await this.read(graphqlArgs(query, vars))
    const answer = graphqlAnswer<T>(res)
    if ('error' in answer) throw new PrHostError(answer.error)
    return answer.body
  }

  private async pullRequestQuery<T>(query: string, ref: PrRef): Promise<T> {
    const body = await this.graphql<{ repository: { pullRequest: T | null } | null }>(query, { owner: ref.owner, name: ref.name, number: ref.number })
    const pr = body.data?.repository?.pullRequest
    if (!pr) throw new PrHostError({ kind: 'not_found', host: 'github', message: `Pull request #${ref.number} was not found.` })
    return pr
  }

  async list(repos: RepoRef[]): Promise<RepoListResult[]> {
    const out: RepoListResult[] = []
    for (let start = 0; start < repos.length; start += REPOS_PER_QUERY) {
      out.push(...await this.listBatch(repos.slice(start, start + REPOS_PER_QUERY)))
    }
    return out
  }

  /**
   * One list request. A batch GitHub could not answer in time (a 5xx, a
   * timeout, a truncated body) is split in half rather than retried whole,
   * down to one repository, which gets the usual one retry and then its own
   * error, so the rest of GitHub still lists. Any other failure (signed out,
   * offline, rate limited) is the whole host's and throws.
   */
  private async listBatch(chunk: RepoRef[]): Promise<RepoListResult[]> {
    if (chunk.length === 0) return []
    const args = graphqlArgs(buildListQuery(chunk))
    const res = chunk.length > 1 ? await this.run(args) : await this.read(args)
    type Row = { open: { nodes: GhPullRequest[] }; merged: { nodes: GhPullRequest[] } } | null
    const answer = graphqlAnswer<{ viewer: { login: string } } & Record<string, Row>>(res)
    if ('error' in answer) {
      if (!answer.transient) throw new PrHostError(answer.error)
      if (chunk.length === 1) {
        log.warn('GitHub could not list a repository', { repo: repoKey(chunk[0]), message: answer.error.message })
        return [{ repo: chunk[0], prs: [], error: answer.error }]
      }
      log.warn('GitHub list batch failed, splitting it', { repos: chunk.length, message: answer.error.message })
      return this.listHalves(chunk)
    }
    const body = answer.body
    const viewer = body.data?.viewer?.login ?? ''
    const out: RepoListResult[] = []
    // GitHub can also answer with partial data: a repository whose resolver timed out comes back null.
    const timedOut: RepoRef[] = []
    chunk.forEach((repo, i) => {
      const row = body.data?.[`r${i}`] as Row | undefined
      if (row) {
        out.push({ repo, prs: [...row.open.nodes, ...row.merged.nodes].map((pr) => mapGhSummary(repo, pr, viewer)), error: null })
        return
      }
      const reason = body.errors?.find((e) => e.path?.[0] === `r${i}`)
      log.warn('repository missing from GitHub response', { repo: repoKey(repo), reason: reason?.message })
      if (reason && isTransientGhFailure({ code: 1, stderr: reason.message })) {
        if (chunk.length > 1) timedOut.push(repo)
        else out.push({ repo, prs: [], error: { kind: 'unknown', host: 'github', message: reason.message } })
        return
      }
      // FORBIDDEN is an organisation that refuses the token (SAML SSO, an IP allow list).
      const kind = reason?.type === 'FORBIDDEN' ? 'forbidden' : 'not_found'
      out.push({ repo, prs: [], error: { kind, host: 'github', message: reason?.message ?? 'GitHub could not find this repository.' } })
    })
    if (timedOut.length === 0) return out
    log.warn('GitHub timed out on part of a list batch, asking again', { repos: timedOut.length })
    const all = [...out, ...await this.listHalves(timedOut)]
    return chunk.flatMap((repo) => all.filter((r) => r.repo === repo))
  }

  private async listHalves(repos: RepoRef[]): Promise<RepoListResult[]> {
    const half = Math.ceil(repos.length / 2)
    return [...await this.listBatch(repos.slice(0, half)), ...await this.listBatch(repos.slice(half))]
  }

  async detail(ref: PrRef): Promise<PrDetail> {
    const body = await this.graphql<{ viewer: { login: string }; repository: (GhRepoMergeSettings & { pullRequest: GhPullRequestDetail | null }) | null }>(
      DETAIL_QUERY, { owner: ref.owner, name: ref.name, number: ref.number })
    const repo = body.data?.repository
    const pr = repo?.pullRequest
    if (!repo || !pr) throw new PrHostError({ kind: 'not_found', host: 'github', message: `Pull request #${ref.number} was not found.` })
    return mapGhDetail(ref, pr, body.data?.viewer.login ?? '', repo)
  }

  async conversations(ref: PrRef): Promise<PrConversation[]> {
    const pr = await this.pullRequestQuery<{ reviewThreads: { nodes: GhReviewThread[] } }>(THREADS_QUERY, ref)
    return mapGhThreads(pr.reviewThreads.nodes)
  }

  async checks(ref: PrRef): Promise<PrCheck[]> {
    const pr = await this.pullRequestQuery<Pick<GhPullRequest, 'commits'>>(CHECKS_QUERY, ref)
    return mapGhChecks(pr)
  }

  async files(ref: PrRef): Promise<PrChangedFile[]> {
    const all: GhPullFile[] = []
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      const res = await this.read(['api', `repos/${ref.owner}/${ref.name}/pulls/${ref.number}/files?per_page=100&page=${page}`])
      if (res.code !== 0) throw new PrHostError(classifyGhError(res))
      const files = parseJson<GhPullFile[]>(res.stdout) ?? []
      all.push(...files)
      if (files.length < 100) break
    }
    return mapGhFiles(all)
  }

  /** A list read the token may not be allowed (collaborators need push access, teams an organisation repo): refused means none. */
  private async optionalList<T>(path: string): Promise<T[]> {
    const res = await this.read(['api', `${path}?per_page=100`])
    if (res.code === 0) return parseJson<T[]>(res.stdout) ?? []
    const error = classifyGhError(res)
    if (error.kind === 'token_rejected' || error.kind === 'gh_missing' || error.kind === 'offline') throw new PrHostError(error)
    log.info('GitHub did not list reviewer candidates', { path, kind: error.kind })
    return []
  }

  async reviewerCandidates(repo: RepoRef): Promise<PrReviewerCandidate[]> {
    const base = `repos/${repo.owner}/${repo.name}`
    const [collaborators, teams] = await Promise.all([
      this.optionalList<GhCollaborator>(`${base}/collaborators`),
      this.optionalList<GhTeam>(`${base}/teams`),
    ])
    return mapGhCandidates(collaborators, teams)
  }

  // ─── Writes ────────────────────────────────────────────────────

  /** One REST write with a JSON body. Returns the parsed answer (may be `null` for 204). */
  private async rest<T = unknown>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: object): Promise<T | null> {
    const args = ['api', '--method', method, path]
    if (body) args.push('--input', '-')
    const res = await this.run(args, body ? { input: JSON.stringify(body) } : {})
    if (res.code !== 0) {
      const error = classifyGhWriteError(res)
      log.warn('GitHub write refused', { method, path, kind: error.kind })
      throw new PrHostError(error)
    }
    return parseJson<T>(res.stdout)
  }

  private async mutate(query: string, variables: Record<string, string>): Promise<void> {
    const res = await this.run(['api', 'graphql', '--input', '-'], { input: JSON.stringify({ query, variables }) })
    const body = parseJson<GraphqlResponse<unknown>>(res.stdout)
    if (res.code !== 0 || body?.errors?.length) {
      const error = classifyGhWriteError(res)
      log.warn('GitHub mutation refused', { kind: error.kind })
      throw new PrHostError(error)
    }
  }

  private repoPath(ref: PrRef): string {
    return `repos/${ref.owner}/${ref.name}`
  }

  async reply(_ref: PrRef, conversationId: string, body: string): Promise<void> {
    await this.mutate(REPLY_MUTATION, { thread: conversationId, body })
  }

  async setResolved(_ref: PrRef, conversationId: string, resolved: boolean): Promise<void> {
    await this.mutate(resolved ? RESOLVE_MUTATION : UNRESOLVE_MUTATION, { thread: conversationId })
  }

  async comment(ref: PrRef, body: string): Promise<void> {
    await this.rest('POST', `${this.repoPath(ref)}/issues/${ref.number}/comments`, { body })
  }

  async inlineComment(ref: PrRef, comment: InlineCommentInput): Promise<void> {
    const pr = await this.pullRequestQuery<{ headRefOid: string }>(HEAD_QUERY, ref)
    await this.rest('POST', `${this.repoPath(ref)}/pulls/${ref.number}/comments`, { commit_id: pr.headRefOid, ...ghLineComment(comment) })
  }

  /**
   * With pending comments: create a pending review holding them, then submit
   * it, so the comments and the verdict land together. A submit that fails
   * deletes the pending review, which would otherwise block the next try
   * ("one pending review per pull request").
   */
  async submitReview(ref: PrRef, review: SubmitReviewInput): Promise<void> {
    const reviews = `${this.repoPath(ref)}/pulls/${ref.number}/reviews`
    const event = REVIEW_EVENT[review.event]
    if (review.comments.length === 0) {
      await this.rest('POST', reviews, { event, body: review.body })
      return
    }
    const pending = await this.rest<{ id?: number }>('POST', reviews, { comments: review.comments.map(ghLineComment) })
    const id = pending?.id
    if (!Number.isInteger(id)) throw new PrHostError({ kind: 'unknown', host: 'github', message: 'GitHub did not return the pending review.' })
    try {
      await this.rest('POST', `${reviews}/${id}/events`, { event, body: review.body })
    } catch (err) {
      try {
        await this.rest('DELETE', `${reviews}/${id}`)
      } catch (cleanup) {
        log.warn('deleting the unsent pending review failed', { number: ref.number, err: String(cleanup) })
      }
      throw err
    }
  }

  /** `sha` makes GitHub refuse (409) when the head moved after the service's pre-check. */
  async merge(ref: PrRef, strategy: MergeStrategy, headSha: string): Promise<void> {
    const method = MERGE_METHOD[strategy]
    if (!method) throw new PrHostError({ kind: 'invalid', host: 'github', message: 'GitHub has no such merge strategy.' })
    await this.rest('PUT', `${this.repoPath(ref)}/pulls/${ref.number}/merge`, { merge_method: method, sha: headSha })
  }

  async rerunCheck(ref: PrRef, check: PrCheck): Promise<void> {
    if (!check.rerunId || !/^[0-9]{1,20}$/.test(check.rerunId)) {
      throw new PrHostError({ kind: 'invalid', host: 'github', message: 'This check is not a GitHub Actions run.' })
    }
    await this.rest('POST', `${this.repoPath(ref)}/actions/runs/${check.rerunId}/rerun-failed-jobs`)
  }

  async addReviewer(ref: PrRef, reviewer: string): Promise<void> {
    await this.rest('POST', `${this.repoPath(ref)}/pulls/${ref.number}/requested_reviewers`, ghReviewerBody(reviewer))
  }

  async removeReviewer(ref: PrRef, reviewer: string): Promise<void> {
    await this.rest('DELETE', `${this.repoPath(ref)}/pulls/${ref.number}/requested_reviewers`, ghReviewerBody(reviewer))
  }

  async decline(ref: PrRef): Promise<void> {
    await this.rest('PATCH', `${this.repoPath(ref)}/pulls/${ref.number}`, { state: 'closed' })
  }

  async defaultBranch(repo: RepoRef): Promise<string> {
    const res = await this.read(['api', `repos/${repo.owner}/${repo.name}`, '--jq', '.default_branch'])
    if (res.code !== 0) throw new PrHostError(classifyGhError(res))
    const branch = res.stdout.trim()
    if (!branch || branch === 'null') throw new PrHostError({ kind: 'unknown', host: 'github', message: 'GitHub did not say which branch is the default.' })
    return branch
  }

  /** Same-repository branches only: `head` is `owner:branch`, so a fork's branch of the same name is not matched. */
  async openPullRequestFor(repo: RepoRef, branch: string): Promise<CreatedPr | null> {
    const head = encodeURIComponent(`${repo.owner}:${branch}`)
    const res = await this.read(['api', `repos/${repo.owner}/${repo.name}/pulls?state=open&per_page=5&head=${head}`])
    if (res.code !== 0) throw new PrHostError(classifyGhError(res))
    const pr = (parseJson<Array<{ number?: number; html_url?: string }>>(res.stdout) ?? [])[0]
    return pr && Number.isInteger(pr.number) && pr.html_url ? { number: pr.number as number, url: pr.html_url } : null
  }

  async createPullRequest(repo: RepoRef, input: CreatePrInput): Promise<CreatedPr> {
    let pr: { number?: number; html_url?: string } | null
    try {
      pr = await this.rest('POST', `repos/${repo.owner}/${repo.name}/pulls`, {
        title: input.title,
        body: input.description,
        head: input.sourceBranch,
        base: input.targetBranch,
        draft: input.draft,
      })
    } catch (err) {
      // GitHub answers a token that may read but not write with 404 as well as 403.
      if (err instanceof PrHostError && (err.error.kind === 'forbidden' || err.error.kind === 'not_found')) {
        throw new PrHostError({ ...err.error, message: `${err.error.message} ${GH_CREATE_SCOPE_HINT}` })
      }
      throw err
    }
    if (!pr || !Number.isInteger(pr.number) || !pr.html_url) {
      throw new PrHostError({ kind: 'unknown', host: 'github', message: 'GitHub did not return the new pull request.' })
    }
    return { number: pr.number as number, url: pr.html_url }
  }
}

const GH_CREATE_SCOPE_HINT =
  "gh's token must be allowed to open pull requests here: the repo scope for a classic token (gh auth refresh -s repo), Pull requests: write for a fine-grained one."

/** `team:<slug>` goes in `team_reviewers`, a login in `reviewers`. */
export function ghReviewerBody(reviewer: string): { reviewers: string[] } | { team_reviewers: string[] } {
  return reviewer.startsWith('team:') ? { team_reviewers: [reviewer.slice('team:'.length)] } : { reviewers: [reviewer] }
}
