/**
 * Reviews backend: finds each project's repository from its git remotes,
 * asks the right host for its pull requests, answers the detail reads, and
 * runs the human writes. Every method returns a `PrResult`, never throws, so
 * the renderer and the phone get one shape for "worked" and "why not".
 *
 * A write validates its input again here, whatever the client checked, and
 * re-reads what it targets first (the thread, the diff line, the head and
 * blockers before a merge), so a stale screen cannot post to the wrong place.
 */
import {
  addReviewerPrecheck,
  findConversation,
  lineInDiff,
  managePrecheck,
  mergePrecheck,
  orderReviewerCandidates,
  recentReviewers,
  removeReviewerPrecheck,
  validateComment,
  validateInlineComment,
  validateMerge,
  validateReply,
  validateRerun,
  validateResolve,
  validateReviewer,
  validateSubmitReview,
  type PrResource,
  type PrWriteDone,
} from '@shared/pull-request-writes'
import {
  HOST_CAPABILITIES,
  repoKey,
  type BitbucketAccountState,
  type PrChangedFile,
  type PrCheck,
  type PrConversation,
  type PrDetail,
  type PrError,
  type PrHost,
  type PrListData,
  type PrRef,
  type PrResult,
  type PrReviewerCandidate,
  type PrSource,
  type PrSummary,
  type RepoRef,
} from '@shared/pull-requests'
import { repoFromRemotes } from '@shared/pull-request-remote'
import { createMainLogger } from '../logger'
import { PrHostError, toPrError, type PullRequestProvider } from './provider'

const log = createMainLogger('pull-requests:service')

/** Remotes rarely change; re-read them at most this often. */
const REMOTES_TTL_MS = 5 * 60_000

export interface PullRequestServiceDeps {
  listProjects(): string[]
  /** `git remote -v` output for a project, or '' when it is not a repository. */
  readRemotes(projectPath: string): Promise<string>
  github(): PullRequestProvider
  /** `null` when no Bitbucket account is usable; `bitbucketState` says why. */
  bitbucket(): PullRequestProvider | null
  bitbucketState(): BitbucketAccountState
  /** `repoKey`s hidden from Reviews: the list skips them without asking the host. */
  hiddenRepos?(): ReadonlySet<string>
  now?: () => number
}

interface DetectedRepos {
  repos: Map<string, { repo: RepoRef; projectPaths: string[] }>
  unsupportedProjects: string[]
}

export function involvesViewer(pr: PrSummary): boolean {
  return pr.viewer.isAuthor || pr.viewer.isRequestedReviewer || pr.viewer.hasReviewed
}

export class PullRequestService {
  private remotes = new Map<string, { at: number; repo: RepoRef | null }>()
  private readonly now: () => number

  constructor(private readonly deps: PullRequestServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  async repoFor(projectPath: string): Promise<RepoRef | null> {
    const hit = this.remotes.get(projectPath)
    if (hit && this.now() - hit.at < REMOTES_TTL_MS) return hit.repo
    let repo: RepoRef | null = null
    try {
      repo = repoFromRemotes(await this.deps.readRemotes(projectPath))
    } catch (err) {
      log.warn('reading git remotes failed', { projectPath, err: String(err) })
    }
    this.remotes.set(projectPath, { at: this.now(), repo })
    return repo
  }

  async detect(): Promise<DetectedRepos> {
    const repos = new Map<string, { repo: RepoRef; projectPaths: string[] }>()
    const unsupportedProjects: string[] = []
    const projects = this.deps.listProjects()
    const found = await Promise.all(projects.map(async (path) => [path, await this.repoFor(path)] as const))
    for (const [path, repo] of found) {
      if (!repo) {
        unsupportedProjects.push(path)
        continue
      }
      const key = repoKey(repo)
      const entry = repos.get(key) ?? { repo, projectPaths: [] }
      entry.projectPaths.push(path)
      repos.set(key, entry)
    }
    return { repos, unsupportedProjects }
  }

  /** Projects whose remotes point at `repo`. */
  async projectPathsFor(repo: RepoRef): Promise<string[]> {
    return (await this.detect()).repos.get(repoKey(repo))?.projectPaths ?? []
  }

  private accountError(host: PrHost): PrError | null {
    if (host !== 'bitbucket' || this.deps.bitbucket()) return null
    const state = this.deps.bitbucketState()
    if (state.state === 'needs_desktop') {
      return { kind: 'needs_desktop', host, message: 'Bitbucket needs the desktop app in this release.' }
    }
    return { kind: 'no_account', host, message: 'Add a Bitbucket account in Settings to see these pull requests.' }
  }

  private provider(host: PrHost): PullRequestProvider | null {
    return host === 'github' ? this.deps.github() : this.deps.bitbucket()
  }

  async list(): Promise<PrResult<PrListData>> {
    try {
      const { repos, unsupportedProjects } = await this.detect()
      const hiddenKeys = this.hiddenRepoKeys()
      const hiddenRepos = [...repos.values()].filter((e) => hiddenKeys.has(repoKey(e.repo))).map((e) => e.repo)
      const sources: PrSource[] = []
      const prs: PrSummary[] = []
      for (const host of ['github', 'bitbucket'] as const) {
        const entries = [...repos.values()].filter((e) => e.repo.host === host && !hiddenKeys.has(repoKey(e.repo)))
        if (entries.length === 0) continue
        const provider = this.provider(host)
        const blocked = this.accountError(host)
        if (!provider || blocked) {
          for (const e of entries) sources.push({ repo: e.repo, projectPaths: e.projectPaths, error: blocked })
          continue
        }
        try {
          const results = await provider.list(entries.map((e) => e.repo))
          for (const result of results) {
            const entry = repos.get(repoKey(result.repo))
            const projectPaths = entry?.projectPaths ?? []
            sources.push({ repo: result.repo, projectPaths, error: result.error })
            for (const pr of result.prs) if (involvesViewer(pr)) prs.push({ ...pr, projectPaths })
          }
        } catch (err) {
          const error = toPrError(err, host)
          log.warn('listing pull requests failed', { host, kind: error.kind })
          for (const e of entries) sources.push({ repo: e.repo, projectPaths: e.projectPaths, error })
        }
      }
      return { ok: true, data: { prs, sources, unsupportedProjects, fetchedAt: this.now(), hidden: [], hiddenRepos } }
    } catch (err) {
      log.error('listing pull requests failed', err)
      return { ok: false, error: toPrError(err, null) }
    }
  }

  private hiddenRepoKeys(): ReadonlySet<string> {
    try {
      return this.deps.hiddenRepos?.() ?? new Set()
    } catch (err) {
      // Reading them all is the safe side: a hidden repository shows its error card again.
      log.warn('reading hidden repositories failed', err)
      return new Set()
    }
  }

  /** Only repositories one of the user's projects points at are read, so a client cannot aim the token anywhere else. */
  private async resolve(ref: unknown): Promise<{ ref: PrRef; provider: PullRequestProvider; projectPaths: string[] } | { error: PrError }> {
    const r = ref as Partial<PrRef> | null
    if (!r || (r.host !== 'github' && r.host !== 'bitbucket') || typeof r.owner !== 'string' || typeof r.name !== 'string' || !Number.isInteger(r.number) || (r.number ?? 0) <= 0) {
      return { error: { kind: 'unknown', host: null, message: 'Not a pull request reference.' } }
    }
    const clean: PrRef = { host: r.host, owner: r.owner, name: r.name, number: r.number as number }
    const entry = (await this.detect()).repos.get(repoKey(clean))
    if (!entry) {
      return { error: { kind: 'unsupported_repo', host: clean.host, message: 'This repository is not one of your projects.' } }
    }
    const blocked = this.accountError(clean.host)
    if (blocked) return { error: blocked }
    const provider = this.provider(clean.host)
    if (!provider) return { error: { kind: 'no_account', host: clean.host, message: 'No account for this host.' } }
    return { ref: clean, provider, projectPaths: entry.projectPaths }
  }

  private async read<T>(
    ref: unknown,
    what: string,
    fn: (p: PullRequestProvider, ref: PrRef, projectPaths: string[]) => Promise<T>,
  ): Promise<PrResult<T>> {
    const target = await this.resolve(ref)
    if ('error' in target) return { ok: false, error: target.error }
    try {
      return { ok: true, data: await fn(target.provider, target.ref, target.projectPaths) }
    } catch (err) {
      const error = toPrError(err, target.ref.host)
      log.warn(`reading pull request ${what} failed`, { host: target.ref.host, number: target.ref.number, kind: error.kind })
      return { ok: false, error }
    }
  }

  detail(ref: unknown): Promise<PrResult<PrDetail>> {
    return this.read(ref, 'detail', async (p, r, projectPaths) => ({ ...(await p.detail(r)), projectPaths }))
  }

  files(ref: unknown): Promise<PrResult<PrChangedFile[]>> {
    return this.read(ref, 'files', (p, r) => p.files(r))
  }

  conversations(ref: unknown): Promise<PrResult<PrConversation[]>> {
    return this.read(ref, 'conversations', (p, r) => p.conversations(r))
  }

  checks(ref: unknown): Promise<PrResult<PrCheck[]>> {
    return this.read(ref, 'checks', (p, r) => p.checks(r))
  }

  /** People who reviewed this repository's listed PRs first, then who the token can see there. */
  reviewerCandidates(ref: unknown): Promise<PrResult<PrReviewerCandidate[]>> {
    return this.read(ref, 'reviewer candidates', async (p, r) => {
      const repo = { host: r.host, owner: r.owner, name: r.name }
      const [listed, members] = await Promise.all([p.list([repo]), p.reviewerCandidates(repo)])
      return orderReviewerCandidates(recentReviewers(listed.flatMap((l) => l.prs)), members)
    })
  }

  // ─── Writes ────────────────────────────────────────────────────

  private async write(
    ref: unknown,
    action: string,
    refresh: PrResource[],
    fn: (p: PullRequestProvider, ref: PrRef) => Promise<void>,
  ): Promise<PrResult<PrWriteDone>> {
    const target = await this.resolve(ref)
    if ('error' in target) return { ok: false, error: target.error }
    try {
      await fn(target.provider, target.ref)
      log.info('pull request write done', { action, host: target.ref.host, number: target.ref.number })
      return { ok: true, data: { refresh } }
    } catch (err) {
      const error = toPrError(err, target.ref.host)
      log.warn(`pull request ${action} failed`, { host: target.ref.host, number: target.ref.number, kind: error.kind })
      return { ok: false, error }
    }
  }

  private static unwrap<T>(v: { ok: true; value: T } | { ok: false; error: PrError }): T {
    if (!v.ok) throw new PrHostError(v.error)
    return v.value
  }

  private async conversationOf(p: PullRequestProvider, ref: PrRef, id: string) {
    const conversation = findConversation(await p.conversations(ref), id)
    if (!conversation) throw new PrHostError({ kind: 'stale', host: ref.host, message: 'That conversation is no longer on the pull request.' })
    return conversation
  }

  reply(ref: unknown, input: unknown): Promise<PrResult<PrWriteDone>> {
    return this.write(ref, 'reply', ['conversations', 'detail'], async (p, r) => {
      const { conversationId, body } = PullRequestService.unwrap(validateReply(r.host, input))
      await this.conversationOf(p, r, conversationId)
      await p.reply(r, conversationId, body)
    })
  }

  setResolved(ref: unknown, input: unknown, resolved: boolean): Promise<PrResult<PrWriteDone>> {
    return this.write(ref, resolved ? 'resolve' : 'unresolve', ['conversations', 'detail'], async (p, r) => {
      const { conversationId } = PullRequestService.unwrap(validateResolve(r.host, input))
      await this.conversationOf(p, r, conversationId)
      await p.setResolved(r, conversationId, resolved)
    })
  }

  comment(ref: unknown, input: unknown): Promise<PrResult<PrWriteDone>> {
    return this.write(ref, 'comment', ['detail'], async (p, r) => {
      const { body } = PullRequestService.unwrap(validateComment(r.host, input))
      await p.comment(r, body)
    })
  }

  inlineComment(ref: unknown, input: unknown): Promise<PrResult<PrWriteDone>> {
    return this.write(ref, 'inline comment', ['conversations', 'detail'], async (p, r) => {
      const comment = PullRequestService.unwrap(validateInlineComment(r.host, input))
      if (!lineInDiff(await p.files(r), comment)) {
        throw new PrHostError({ kind: 'stale', host: r.host, message: `${comment.path}:${comment.line} is not in the diff any more.` })
      }
      await p.inlineComment(r, comment)
    })
  }

  submitReview(ref: unknown, input: unknown): Promise<PrResult<PrWriteDone>> {
    return this.write(ref, 'review', ['conversations', 'detail'], async (p, r) => {
      const review = PullRequestService.unwrap(validateSubmitReview(r.host, input))
      const [detail, files] = await Promise.all([p.detail(r), review.comments.length > 0 ? p.files(r) : Promise.resolve([])])
      if (review.event !== 'comment') {
        if (detail.viewer.isAuthor) {
          throw new PrHostError({ kind: 'forbidden', host: r.host, message: 'You cannot approve or request changes on your own pull request.' })
        }
        if (detail.state !== 'open') throw new PrHostError({ kind: 'stale', host: r.host, message: `This pull request is ${detail.state} now.` })
      }
      const gone = review.comments.find((c) => !lineInDiff(files, c))
      if (gone) throw new PrHostError({ kind: 'stale', host: r.host, message: `${gone.path}:${gone.line} is not in the diff any more. Remove that comment and submit again.` })
      await p.submitReview(r, review)
    })
  }

  merge(ref: unknown, input: unknown): Promise<PrResult<PrWriteDone>> {
    return this.write(ref, 'merge', ['detail', 'checks'], async (p, r) => {
      const merge = PullRequestService.unwrap(validateMerge(r.host, input))
      const refused = mergePrecheck(await p.detail(r), merge)
      if (refused) throw new PrHostError(refused)
      await p.merge(r, merge.strategy, merge.expectedHeadSha)
    })
  }

  rerunCheck(ref: unknown, input: unknown): Promise<PrResult<PrWriteDone>> {
    return this.write(ref, 'rerun', ['checks', 'detail'], async (p, r) => {
      const { checkId } = PullRequestService.unwrap(validateRerun(r.host, input))
      const caps = HOST_CAPABILITIES[r.host]
      if (!caps.rerunChecks) throw new PrHostError({ kind: 'forbidden', host: r.host, message: caps.rerunUnavailable ?? 'This host cannot re-run checks.' })
      const check = (await p.checks(r)).find((c) => c.id === checkId)
      if (!check) throw new PrHostError({ kind: 'stale', host: r.host, message: 'That check is no longer on the head commit.' })
      if (check.state !== 'failure') throw new PrHostError({ kind: 'stale', host: r.host, message: `${check.name} is not failed any more.` })
      if (!check.rerunId) throw new PrHostError({ kind: 'invalid', host: r.host, message: `${check.name} is not a GitHub Actions run; re-run it where it ran.` })
      await p.rerunCheck(r, check)
    })
  }

  addReviewer(ref: unknown, input: unknown): Promise<PrResult<PrWriteDone>> {
    return this.write(ref, 'add reviewer', ['detail'], async (p, r) => {
      const change = PullRequestService.unwrap(validateReviewer(r.host, input))
      const refused = addReviewerPrecheck(await p.detail(r), change)
      if (refused) throw new PrHostError(refused)
      await p.addReviewer(r, change.reviewer)
    })
  }

  removeReviewer(ref: unknown, input: unknown): Promise<PrResult<PrWriteDone>> {
    return this.write(ref, 'remove reviewer', ['detail'], async (p, r) => {
      const change = PullRequestService.unwrap(validateReviewer(r.host, input))
      const refused = removeReviewerPrecheck(await p.detail(r), change)
      if (refused) throw new PrHostError(refused)
      await p.removeReviewer(r, change.reviewer)
    })
  }

  decline(ref: unknown): Promise<PrResult<PrWriteDone>> {
    return this.write(ref, 'decline', ['detail'], async (p, r) => {
      const refused = managePrecheck(await p.detail(r), r.host === 'github' ? 'close it' : 'decline it')
      if (refused) throw new PrHostError(refused)
      await p.decline(r)
    })
  }
}
