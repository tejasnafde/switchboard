/**
 * Keeps a chat's PR links current without the agent's help:
 *
 * - Branch detection: at session start and at each turn end, the open PR of
 *   the branch checked out in the chat's working directory is linked
 *   (automatically, so a tombstone holds), when it is on a repository the
 *   project covers. So a second chat opened on the branch of a PR the first
 *   one raised links it too. The host answer is cached per repository and
 *   branch, so a turn end costs one local git call.
 * - Link state: a shell command that merges or closes a PR (`gh pr merge`,
 *   `bbpr decline`, ...) re-reads the state of the chat's open links once it
 *   completes; otherwise a link's state is re-read at most every
 *   `STATE_TTL_MS`, at a turn end. Merged and closed links are not re-read.
 *
 * Failures go to `problem`, which the agent reads through
 * `list_thread_pull_requests`, and to the log.
 */
import type { RuntimeEvent } from '@shared/provider-events'
import { toolInputCommand } from '@shared/bbpr-command'
import { mergesOrClosesPr, type PrLink } from '@shared/pull-request-links'
import { projectCoversRepo, type ProjectRepos } from '@shared/project-repos'
import { prKey, repoKey, type PrRef, type PrResult, type PrState, type RepoRef } from '@shared/pull-requests'
import type { CreatedPr } from '@shared/agent-pr-create'
import { createMainLogger } from '../logger'

const log = createMainLogger('pull-requests:link-sync')

/** How long a branch's open PR (or its absence) is trusted. */
export const BRANCH_TTL_MS = 5 * 60_000
/** How long a link's stored state is trusted before a turn end re-reads it. */
export const STATE_TTL_MS = 15 * 60_000
/** A host read that failed is not repeated at a turn end for this long, so an offline backend is not asked every turn. */
export const RETRY_AFTER_MS = 60_000

export interface LinkSyncDeps {
  /** Root conversation id, project and working directory of a thread, `null` when it has no row. */
  conversationFor(threadId: string): Chat | null
  projectRepos(projectPath: string): Promise<ProjectRepos>
  /** Every repository a directory's remotes point at. */
  reposFor(dir: string): Promise<RepoRef[]>
  currentBranch(cwd: string): Promise<string | null>
  openPullRequestFor(repo: RepoRef, branch: string): Promise<PrResult<CreatedPr | null>>
  /** The chat's live links. */
  linkedPrs(chatId: string): PrLink[]
  /** An automatic link; returns whether it was added. */
  link(chatId: string, ref: PrRef): boolean
  prState(ref: PrRef): Promise<PrResult<PrState>>
  /** Stores a PR's state, read from `observedAt` on, on its links; returns the chats whose link changed. */
  setState(ref: PrRef, state: PrState, observedAt: number): string[]
  notify(chatId: string): void
  problem(chatId: string, message: string): void
  now?: () => number
}

type Chat = { id: string; projectPath: string; cwd: string }

const TERMINAL: ReadonlySet<PrState> = new Set(['merged', 'closed'])

export class PullRequestLinkSync {
  private branches = new Map<string, { at: number; number: number | null }>()
  /** Failed reads by branch key or `prKey`, and when. */
  private failedAt = new Map<string, number>()
  /** Threads that started a merge or close command; their links are re-read when a tool completes. */
  private merging = new Set<string>()
  private running = new Set<string>()
  /** Chats whose merge or close command completed during a sync; a forced re-read runs once that sync ends. */
  private forcedAfterRun = new Set<string>()
  private readonly now: () => number

  constructor(private readonly deps: LinkSyncDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Resolves once any work the event started has finished (tests await it). */
  async onEvent(event: RuntimeEvent): Promise<void> {
    if (event.type === 'tool.started') {
      let input: string
      try {
        input = typeof event.input === 'string' ? event.input : (JSON.stringify(event.input) ?? '')
      } catch (err) {
        log.debug('tool input is not serialisable', { err: String(err) })
        return
      }
      const command = toolInputCommand(input)
      if (command && mergesOrClosesPr(command)) this.merging.add(event.threadId)
      return
    }
    if (event.type === 'tool.completed' && this.merging.delete(event.threadId)) {
      const chat = this.deps.conversationFor(event.threadId)
      if (chat && this.running.has(chat.id)) {
        this.forcedAfterRun.add(chat.id)
        return
      }
      await this.run(event.threadId, this.forcedRefresh)
      return
    }
    if (event.type === 'session.provider' || event.type === 'turn.completed') {
      await this.run(event.threadId, async (chat, changed) => {
        await this.detectBranchPr(chat, changed)
        await this.refreshStates(chat, false, changed)
      })
    }
  }

  private readonly forcedRefresh = (chat: Chat, changed: Set<string>) => this.refreshStates(chat, true, changed)

  /**
   * One sync per chat at a time; an event that arrives during one is dropped
   * (the next turn end repeats it), except a forced re-read after a merge or
   * close command, which runs once the sync ends.
   */
  private async run(threadId: string, work: (chat: Chat, changed: Set<string>) => Promise<void>): Promise<void> {
    const chat = this.deps.conversationFor(threadId)
    if (!chat || this.running.has(chat.id)) return
    this.running.add(chat.id)
    const changed = new Set<string>()
    try {
      await work(chat, changed)
    } catch (err) {
      log.warn('syncing pull request links failed', { threadId, err: String(err) })
      this.deps.problem(chat.id, `Syncing linked pull requests failed: ${String(err)}`)
    } finally {
      this.running.delete(chat.id)
      for (const id of changed) this.deps.notify(id)
    }
    if (this.forcedAfterRun.delete(chat.id)) await this.run(threadId, this.forcedRefresh)
  }

  private async detectBranchPr(chat: Chat, changed: Set<string>): Promise<void> {
    const branch = await this.deps.currentBranch(chat.cwd)
    if (!branch) return
    const project = await this.deps.projectRepos(chat.projectPath)
    const repos = (await this.deps.reposFor(chat.cwd)).filter((repo) => projectCoversRepo(project, repo))
    for (const repo of repos) {
      const number = await this.branchPr(chat.id, repo, branch)
      if (number === null) continue
      if (this.deps.link(chat.id, { ...repo, number })) {
        log.info('linked the pull request of the chat branch', { host: repo.host, number })
        changed.add(chat.id)
      }
      return
    }
  }

  private async branchPr(chatId: string, repo: RepoRef, branch: string): Promise<number | null> {
    const key = `${repoKey(repo)}|${branch}`
    const hit = this.branches.get(key)
    if (hit && this.now() - hit.at < BRANCH_TTL_MS) return hit.number
    if (this.now() - (this.failedAt.get(key) ?? -Infinity) < RETRY_AFTER_MS) return null
    const read = await this.deps.openPullRequestFor(repo, branch)
    if (!read.ok) {
      this.failedAt.set(key, this.now())
      log.warn('looking up the pull request of a branch failed', { host: repo.host, kind: read.error.kind })
      this.deps.problem(
        chatId,
        `Could not look up the pull request of branch ${branch} on ${repo.owner}/${repo.name}: ${read.error.message}`,
      )
      return null
    }
    const number = read.data?.number ?? null
    this.failedAt.delete(key)
    this.branches.set(key, { at: this.now(), number })
    return number
  }

  private async refreshStates(chat: Chat, force: boolean, changed: Set<string>): Promise<void> {
    const now = this.now()
    const due = this.deps
      .linkedPrs(chat.id)
      .filter(
        (link) =>
          !(link.state && TERMINAL.has(link.state)) &&
          (force ||
            (now - (link.stateAt ?? 0) >= STATE_TTL_MS &&
              now - (this.failedAt.get(prKey(link.ref)) ?? -Infinity) >= RETRY_AFTER_MS)),
      )
    for (const { ref } of due) {
      const observedAt = this.now()
      const read = await this.deps.prState(ref)
      if (!read.ok) {
        this.failedAt.set(prKey(ref), this.now())
        log.warn('reading a linked pull request state failed', { host: ref.host, kind: read.error.kind })
        this.deps.problem(
          chat.id,
          `Could not read the state of ${ref.owner}/${ref.name} #${ref.number}: ${read.error.message}`,
        )
        continue
      }
      this.failedAt.delete(prKey(ref))
      for (const id of this.deps.setState(ref, read.data, observedAt)) changed.add(id)
    }
  }
}
