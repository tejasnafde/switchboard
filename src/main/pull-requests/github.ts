/**
 * GitHub through the `gh` CLI where the backend runs: `gh api graphql` for
 * pull requests, reviews, threads and checks, `gh api` (REST) for changed
 * files with their patches. gh holds the token; Switchboard never asks for
 * it, so nothing here can print one.
 */
import { execFile } from 'node:child_process'
import type { PrChangedFile, PrCheck, PrConversation, PrDetail, PrRef, RepoRef } from '@shared/pull-requests'
import { repoKey } from '@shared/pull-requests'
import { childProcessEnv } from '../shell-env'
import { createMainLogger } from '../logger'
import {
  classifyGhError,
  mapGhChecks,
  mapGhDetail,
  mapGhFiles,
  mapGhSummary,
  mapGhThreads,
  type GhPullFile,
  type GhPullRequest,
  type GhPullRequestDetail,
  type GhReviewThread,
} from './github-map'
import { PrHostError, type PullRequestProvider, type RepoListResult } from './provider'

const log = createMainLogger('pull-requests:github')

export interface GhRunResult {
  stdout: string
  stderr: string
  /** Exit code, or the spawn error code (`ENOENT` when gh is missing). `0` on success. */
  code: number | string | null
}

export type GhRunner = (args: string[]) => Promise<GhRunResult>

const GH_TIMEOUT_MS = 30_000
const OPEN_PER_REPO = 30
const MERGED_PER_REPO = 15
/** Repositories per GraphQL request; keeps one request's cost well under the node limit. */
const REPOS_PER_QUERY = 8
const MAX_FILE_PAGES = 3

export const defaultGhRunner: GhRunner = (args) =>
  new Promise((resolve) => {
    execFile('gh', args, { env: childProcessEnv(), timeout: GH_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException).code ?? (err as { code?: number }).code ?? 1) : 0
      resolve({ stdout: String(stdout), stderr: String(stderr), code })
    })
  })

const PR_FIELDS = `
  number title url state isDraft createdAt updatedAt mergedAt
  headRefName baseRefName headRefOid additions deletions changedFiles
  author { login avatarUrl ... on User { name } }
  baseRef { branchProtectionRule { requiredApprovingReviewCount } }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login name avatarUrl } } } }
  latestReviews(first: 20) { nodes { state submittedAt author { login avatarUrl ... on User { name } } } }
  reviewThreads(first: 100) { totalCount nodes { isResolved } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 50) { nodes {
    __typename
    ... on CheckRun { name status conclusion startedAt completedAt detailsUrl }
    ... on StatusContext { context state targetUrl description createdAt }
  } } } } } }
`

export function buildListQuery(repos: readonly RepoRef[]): string {
  const blocks = repos.map((r, i) => `
  r${i}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.name)}) {
    open: pullRequests(states: OPEN, first: ${OPEN_PER_REPO}, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ...Pr } }
    merged: pullRequests(states: MERGED, first: ${MERGED_PER_REPO}, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ...Pr } }
  }`).join('')
  return `query {\n  viewer { login }${blocks}\n}\nfragment Pr on PullRequest {${PR_FIELDS}}`
}

const DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    ${PR_FIELDS}
    body mergeable
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
      id isResolved isOutdated path line originalLine diffSide
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

export class GitHubProvider implements PullRequestProvider {
  readonly host = 'github' as const

  constructor(private readonly run: GhRunner = defaultGhRunner) {}

  /** The signed-in login, or the classified reason there is none. */
  async viewerLogin(): Promise<string> {
    const res = await this.run(['api', 'user', '--jq', '.login'])
    if (res.code !== 0) throw new PrHostError(classifyGhError(res))
    return res.stdout.trim()
  }

  /** Runs a query; a response carrying `data` is returned even when gh exits non-zero, so one missing repo does not sink the rest. */
  private async graphql<T>(query: string, vars: Record<string, string | number> = {}): Promise<GraphqlResponse<T>> {
    const args = ['api', 'graphql', '-f', `query=${query}`]
    for (const [key, value] of Object.entries(vars)) {
      args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`)
    }
    const res = await this.run(args)
    const body = parseJson<GraphqlResponse<T>>(res.stdout)
    if (res.code !== 0 && !body?.data) {
      const message = body?.errors?.map((e) => e.message).join('; ')
      throw new PrHostError(classifyGhError({ ...res, stderr: `${res.stderr}\n${message ?? ''}` }))
    }
    if (!body) throw new PrHostError({ kind: 'unknown', host: 'github', message: 'gh returned no data.' })
    return body
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
      const chunk = repos.slice(start, start + REPOS_PER_QUERY)
      type Row = { open: { nodes: GhPullRequest[] }; merged: { nodes: GhPullRequest[] } } | null
      const body = await this.graphql<{ viewer: { login: string } } & Record<string, Row>>(buildListQuery(chunk))
      const viewer = body.data?.viewer?.login ?? ''
      chunk.forEach((repo, i) => {
        const row = body.data?.[`r${i}`] as Row | undefined
        if (!row) {
          const reason = body.errors?.find((e) => e.path?.[0] === `r${i}`)
          log.warn('repository missing from GitHub response', { repo: repoKey(repo), reason: reason?.message })
          out.push({ repo, prs: [], error: { kind: 'not_found', host: 'github', message: reason?.message ?? 'GitHub could not find this repository.' } })
          return
        }
        const prs = [...row.open.nodes, ...row.merged.nodes].map((pr) => mapGhSummary(repo, pr, viewer))
        out.push({ repo, prs, error: null })
      })
    }
    return out
  }

  async detail(ref: PrRef): Promise<PrDetail> {
    const body = await this.graphql<{ viewer: { login: string }; repository: { pullRequest: GhPullRequestDetail | null } | null }>(
      DETAIL_QUERY, { owner: ref.owner, name: ref.name, number: ref.number })
    const pr = body.data?.repository?.pullRequest
    if (!pr) throw new PrHostError({ kind: 'not_found', host: 'github', message: `Pull request #${ref.number} was not found.` })
    return mapGhDetail(ref, pr, body.data?.viewer.login ?? '')
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
      const res = await this.run(['api', `repos/${ref.owner}/${ref.name}/pulls/${ref.number}/files?per_page=100&page=${page}`])
      if (res.code !== 0) throw new PrHostError(classifyGhError(res))
      const files = parseJson<GhPullFile[]>(res.stdout) ?? []
      all.push(...files)
      if (files.length < 100) break
    }
    return mapGhFiles(all)
  }
}
