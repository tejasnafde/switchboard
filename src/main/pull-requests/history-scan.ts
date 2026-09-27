/**
 * Links chats from before PR linking existed: reads a chat's stored history
 * (the same loader that opens it) and applies the auto-link rule to its user
 * text, assistant text and tool output. Runs once per chat in the background
 * after launch; later messages are the live auto-linker's (`auto-link.ts`).
 */
import type { ChatMessage } from '@shared/types'
import { autoLinkRefs } from '@shared/pull-request-links'
import type { PrRef, RepoRef } from '@shared/pull-requests'
import { createMainLogger } from '../logger'

const log = createMainLogger('pull-requests:history-scan')

/** Text read per chat, from its first message on; the rest of a longer chat is not scanned. */
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
  loadHistory(conversationId: string, projectPath: string): Promise<{ messages: ChatMessage[] }>
  repoForProject(projectPath: string): Promise<RepoRef | null>
  link(conversationId: string, ref: PrRef): boolean
  notify(conversationId: string): void
  markScanned(conversationId: string, now?: number): void
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function appendPart(parts: string[], part: string | undefined, state: { chars: number; capped: boolean }): void {
  if (!part || state.chars >= MAX_HISTORY_SCAN_CHARS) return
  const remaining = MAX_HISTORY_SCAN_CHARS - state.chars
  if (part.length > remaining) {
    parts.push(part.slice(0, remaining))
    state.chars = MAX_HISTORY_SCAN_CHARS
    state.capped = true
    return
  }
  parts.push(part)
  state.chars += part.length
}

function historyText(messages: readonly ChatMessage[]): { text: string; scannedChars: number; capped: boolean } {
  const parts: string[] = []
  const state = { chars: 0, capped: false }
  for (const message of messages) {
    appendPart(parts, message.content, state)
    for (const call of message.toolCalls ?? []) {
      appendPart(parts, call.output, state)
    }
    if (state.capped) break
  }
  return { text: parts.join('\n'), scannedChars: state.chars, capped: state.capped }
}

export async function scanPullRequestHistoryForConversation(
  target: PullRequestHistoryScanTarget,
  deps: PullRequestHistoryScanDeps,
): Promise<PullRequestHistoryScanResult> {
  const history = await deps.loadHistory(target.id, target.projectPath)
  const { text, scannedChars, capped } = historyText(history.messages)
  let linked = 0
  if (MENTIONS_HOST.test(text)) {
    const repo = await deps.repoForProject(target.projectPath)
    for (const ref of autoLinkRefs(text, repo)) {
      if (deps.link(target.id, ref)) linked++
    }
  }
  if (linked > 0) deps.notify(target.id)
  deps.markScanned(target.id)
  return { conversationId: target.id, scannedChars, capped, linked }
}

/**
 * Scans every chat not scanned yet, a batch at a time, until none is left.
 * A chat whose scan fails is still marked, so one unreadable transcript is not
 * retried on every launch; the manual action scans it again.
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
  for (;;) {
    // A chat that comes back after its attempt could not be marked; stop rather than loop on it.
    const pending = deps.listUnscanned(batchSize).filter((target) => !attempted.has(target.id))
    if (pending.length === 0) return results
    for (const target of pending) attempted.add(target.id)
    let index = 0
    const worker = async (): Promise<void> => {
      for (let target = pending[index++]; target; target = pending[index++]) {
        try {
          results.push(await scanPullRequestHistoryForConversation(target, deps))
        } catch (err) {
          log.warn('history pull request scan failed', { conversationId: target.id, err: String(err) })
          deps.markScanned(target.id)
        }
        if (yieldMs > 0) await wait(yieldMs)
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker))
  }
}
