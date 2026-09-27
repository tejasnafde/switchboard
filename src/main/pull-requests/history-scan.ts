/**
 * Links chats from before PR linking existed: reads a chat's stored history
 * (`history-source.ts`) and applies the auto-link rule to its user text,
 * assistant text, tool inputs and tool output, plus bbpr's bare-number form
 * (`bbpr 605`) in a tool input for a Bitbucket project. Runs once per chat in
 * the background after launch; later messages are the live auto-linker's
 * (`auto-link.ts`).
 */
import { autoLinkRefs } from '@shared/pull-request-links'
import { bbprPullRequestNumbers, toolInputCommand } from '@shared/bbpr-command'
import type { PrRef, RepoRef } from '@shared/pull-requests'
import type { HistoryPartKind, HistoryVisitor } from './history-source'
import { createMainLogger } from '../logger'

const log = createMainLogger('pull-requests:history-scan')

/** Text read per chat, from its first message on; the rest of a longer chat is not read. */
export const MAX_HISTORY_SCAN_CHARS = 250_000
const DEFAULT_BATCH_SIZE = 50
const DEFAULT_CONCURRENCY = 2
const DEFAULT_YIELD_MS = 25
const MENTIONS_HOST = /github\.com\/|bitbucket\.org\//i

export interface PullRequestHistoryScanTarget {
  id: string
  projectPath: string
}

export interface PullRequestHistoryScanDeps {
  listUnscanned(limit: number): PullRequestHistoryScanTarget[]
  /** Feeds the chat's history to `visit` in order, stopping when it returns false. */
  readHistory(conversationId: string, visit: HistoryVisitor): Promise<void>
  repoForProject(projectPath: string): Promise<RepoRef | null>
  link(conversationId: string, ref: PrRef): boolean
  notify(conversationId: string): void
  markScanned(conversationId: string): void
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
  readonly bbprNumbers: number[] = []
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
    if (kind === 'toolInput') this.addBbprNumbers(text.length > remaining ? kept : text)
    this.parts.push(kept)
    if (text.length > remaining) {
      this.chars = MAX_HISTORY_SCAN_CHARS
      this.capped = true
      return false
    }
    this.chars += text.length
    return true
  }

  private addBbprNumbers(input: string): void {
    const command = toolInputCommand(input)
    for (const number of command ? bbprPullRequestNumbers(command) : []) {
      if (!this.bbprNumbers.includes(number)) this.bbprNumbers.push(number)
    }
  }

  get text(): string {
    return this.parts.join('\n')
  }
}

/** PRs of the chat's project that its history names. */
function historyRefs(history: HistoryText, repo: RepoRef | null): PrRef[] {
  const refs = autoLinkRefs(history.text, repo)
  // bbpr resolves a bare number against the current git remote, which is the project's.
  if (repo?.host === 'bitbucket') {
    for (const number of history.bbprNumbers) {
      if (!refs.some((ref) => ref.number === number)) refs.push({ ...repo, number })
    }
  }
  return refs
}

function markQuietly(deps: PullRequestHistoryScanDeps, conversationId: string): void {
  try {
    deps.markScanned(conversationId)
  } catch (err) {
    log.warn('recording a PR history scan failed', { conversationId, err: String(err) })
  }
}

/** Scans one chat and records it as scanned. Throws only when its history cannot be read. */
export async function scanPullRequestHistoryForConversation(
  target: PullRequestHistoryScanTarget,
  deps: PullRequestHistoryScanDeps,
): Promise<PullRequestHistoryScanResult> {
  const history = new HistoryText()
  await deps.readHistory(target.id, (kind, text) => history.add(kind, text))
  let linked = 0
  if (history.bbprNumbers.length > 0 || MENTIONS_HOST.test(history.text)) {
    const repo = await deps.repoForProject(target.projectPath)
    for (const ref of historyRefs(history, repo)) {
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
 * again. A chat that could not be marked is skipped for the rest of the run.
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
  // Attempted chats the list still returns (their mark failed); the page is widened past them.
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
          markQuietly(deps, target.id)
        }
        if (yieldMs > 0) await wait(yieldMs)
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker))
  }
}
