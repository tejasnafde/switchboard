/**
 * Reviews backend: finds each project's repository from its git remotes,
 * asks the right host for its pull requests, and answers the detail reads.
 * Every method returns a `PrResult`, never throws, so the renderer and the
 * phone get one shape for "worked" and "why not".
 */
import {
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
  type PrSource,
  type PrSummary,
  type RepoRef,
} from '@shared/pull-requests'
import { repoFromRemotes } from '@shared/pull-request-remote'
import { createMainLogger } from '../logger'
import { toPrError, type PullRequestProvider } from './provider'

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

  private async repoFor(projectPath: string): Promise<RepoRef | null> {
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
      const sources: PrSource[] = []
      const prs: PrSummary[] = []
      for (const host of ['github', 'bitbucket'] as const) {
        const entries = [...repos.values()].filter((e) => e.repo.host === host)
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
      return { ok: true, data: { prs, sources, unsupportedProjects, fetchedAt: this.now() } }
    } catch (err) {
      log.error('listing pull requests failed', err)
      return { ok: false, error: toPrError(err, null) }
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
}
