/**
 * Links chats from before PR linking existed: reads a chat's stored history
 * (`history-source.ts`) and applies the live auto-linker's rule
 * (`auto-link.ts`): the PR a tool's shell command works on
 * (`shared/pr-command-links.ts`), the output of `gh pr create`, and bbpr's
 * bare-number form (`bbpr 605`) in a tool input for a Bitbucket project, when
 * the command ran in the chat's repository (`bbpr-targets.ts`). A PR only
 * named in chat text or in other tool output is not linked. Runs once per
 * chat in the background after launch.
 */
import { projectPrRefs } from '@shared/pull-request-links'
import { bbprPullRequestNumbers, bbprTargetsForInput, toolInputCommand, toolInputCwd } from '@shared/bbpr-command'
import { prCommandLinks } from '@shared/pr-command-links'
import type { PrRef, RepoRef } from '@shared/pull-requests'
import type { ProjectRepos } from '@shared/project-repos'
import type { HistoryPartKind, HistoryVisitor } from './history-source'
import { createMainLogger } from '../logger'
import { bbprNumbersInRepo } from './bbpr-targets'

const log = createMainLogger('pull-requests:history-scan')

/** Text read per chat, from its first message on; the rest of a longer chat is not read. */
export const MAX_HISTORY_SCAN_CHARS = 250_000
const DEFAULT_BATCH_SIZE = 50
const DEFAULT_CONCURRENCY = 2
const DEFAULT_YIELD_MS = 25

export interface PullRequestHistoryScanTarget {
  id: string
  projectPath: string
  /** Where the chat's tools ran (its worktree), when not the project: a bare `bbpr <n>` with no `cd` ran here. */
  worktreePath?: string | null
}

export interface PullRequestHistoryScanDeps {
  listUnscanned(limit: number): PullRequestHistoryScanTarget[]
  /** Feeds the chat's history to `visit` in order, stopping when it returns false. */
  readHistory(conversationId: string, visit: HistoryVisitor): Promise<void>
  /** The repositories a project covers (`PullRequestService.projectRepos`). */
  projectRepos(projectPath: string): Promise<ProjectRepos>
  /** The repository a directory's git remotes point at: a directory a `bbpr` command `cd`s into. */
  repoForProject(path: string): Promise<RepoRef | null>
  link(conversationId: string, ref: PrRef): boolean
  notify(conversationId: string): void
  markScanned(conversationId: string): void
  /** A chat's background scan failed; the agent sees it through `list_thread_pull_requests`. */
  problem?(conversationId: string, message: string): void
}

export interface PullRequestHistoryScanResult {
  conversationId: string
  scannedChars: number
  capped: boolean
  linked: number
}

export interface PullRequestHistoryScanOptions {
  batchSize?: number
  concurrency?: number
  yieldMs?: number
}

/** `text` without its last word (a regex like /\S*$/ backtracks quadratically on long input). */
function dropLastWord(text: string): string {
  let end = text.length
  while (end > 0 && !/\s/.test(text[end - 1])) end--
  return text.slice(0, end)
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The history text kept for matching, at most `MAX_HISTORY_SCAN_CHARS`. A part
 * cut by the cap loses its last word too, so a URL or number cut in half
 * (`/pull/6` of `/pull/612`) is never matched.
 */
class HistoryText {
  private parts: string[] = []
  private seen = new Set<string>()
  /** Shell commands of tool inputs that run bbpr, resolved against the chat's cwd once the read is done. */
  readonly bbprCommands: Array<{ command: string; cwd: string | null }> = []
  /**
   * `gh pr create` calls whose output has not been read yet. A transcript
   * keeps a tool's output after its input, so the next outputs are theirs.
   */
  private creates = 0
  chars = 0
  capped = false

  /** Returns false once the cap is reached. */
  add(kind: HistoryPartKind, text: string): boolean {
    if (!text.trim() || this.seen.has(text)) return !this.capped
    if (this.chars >= MAX_HISTORY_SCAN_CHARS) {
      this.capped = true
      return false
    }
    this.seen.add(text)
    const remaining = MAX_HISTORY_SCAN_CHARS - this.chars
    const kept = text.length > remaining ? dropLastWord(text.slice(0, remaining)) : text
    if (kind === 'toolInput') this.addToolInput(kept)
    else if (kind === 'toolOutput' && this.creates > 0) {
      this.creates--
      this.parts.push(kept)
    }
    if (text.length > remaining) {
      this.chars = MAX_HISTORY_SCAN_CHARS
      this.capped = true
      return false
    }
    this.chars += text.length
    return true
  }

  private addToolInput(input: string): void {
    const command = toolInputCommand(input)
    if (!command) return
    const { urls, creates } = prCommandLinks(command)
    this.parts.push(...urls)
    if (creates) this.creates++
    if (bbprPullRequestNumbers(command).length > 0) this.bbprCommands.push({ command, cwd: toolInputCwd(input) })
  }

  get text(): string {
    return this.parts.join('\n')
  }
}

function markQuietly(deps: PullRequestHistoryScanDeps, conversationId: string): void {
  try {
    deps.markScanned(conversationId)
  } catch (err) {
    log.warn('recording a PR history scan failed', { conversationId, err: String(err) })
  }
}

/** The chat's history could not be read; any other scan failure is worth retrying. */
export class HistoryReadError extends Error {
  constructor(readonly reason: unknown) {
    super(`reading the chat's history failed: ${String(reason)}`)
    this.name = 'HistoryReadError'
  }
}

/**
 * Scans one chat and records it as scanned. Throws `HistoryReadError` when its
 * history cannot be read, and whatever the repository lookup or a link threw.
 */
export async function scanPullRequestHistoryForConversation(
  target: PullRequestHistoryScanTarget,
  deps: PullRequestHistoryScanDeps,
): Promise<PullRequestHistoryScanResult> {
  const history = new HistoryText()
  try {
    await deps.readHistory(target.id, (kind, text) => history.add(kind, text))
  } catch (err) {
    throw new HistoryReadError(err)
  }
  let linked = 0
  if (history.bbprCommands.length > 0 || history.text) {
    const project = await deps.projectRepos(target.projectPath)
    const cwd = target.worktreePath || target.projectPath
    const targets = history.bbprCommands.flatMap((c) => bbprTargetsForInput(c.command, cwd, c.cwd))
    const bbprNumbers = await bbprNumbersInRepo(targets, project.own, (dir) => deps.repoForProject(dir))
    for (const ref of projectPrRefs(history.text, bbprNumbers, project)) {
      if (deps.link(target.id, ref)) linked++
    }
  }
  if (linked > 0) deps.notify(target.id)
  markQuietly(deps, target.id)
  return { conversationId: target.id, scannedChars: history.chars, capped: history.capped, linked }
}

/**
 * Scans every chat not scanned yet, a batch at a time, until none is left.
 * A chat whose history cannot be read is still marked, so one unreadable
 * transcript is not retried on every launch; the manual action scans it
 * again. A chat whose repository lookup or linking failed stays unmarked, so
 * the next launch retries it. Either way a chat is tried once per run.
 */
export async function scanPendingPullRequestHistory(
  deps: PullRequestHistoryScanDeps,
  options: PullRequestHistoryScanOptions = {},
): Promise<PullRequestHistoryScanResult[]> {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE)
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
  const yieldMs = options.yieldMs ?? DEFAULT_YIELD_MS
  const results: PullRequestHistoryScanResult[] = []
  const attempted = new Set<string>()
  // Attempted chats the list still returns (left unmarked); the page is widened past them.
  const stuck = new Set<string>()
  for (;;) {
    const limit = batchSize + stuck.size
    const page = deps.listUnscanned(limit)
    const pending = page.filter((target) => !attempted.has(target.id))
    for (const target of page) if (attempted.has(target.id)) stuck.add(target.id)
    if (pending.length === 0) {
      // A full page of stuck chats widened the next page; a short one was the end.
      if (page.length < limit) return results
      continue
    }
    for (const target of pending) attempted.add(target.id)
    let index = 0
    const worker = async (): Promise<void> => {
      for (let target = pending[index++]; target; target = pending[index++]) {
        try {
          results.push(await scanPullRequestHistoryForConversation(target, deps))
        } catch (err) {
          log.warn('history pull request scan failed', { conversationId: target.id, err: String(err) })
          deps.problem?.(target.id, `Scanning this chat's history for pull requests failed: ${String(err)}`)
          if (err instanceof HistoryReadError) markQuietly(deps, target.id)
        }
        if (yieldMs > 0) await wait(yieldMs)
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker))
  }
}
