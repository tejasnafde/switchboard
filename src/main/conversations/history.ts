import type { ChatLoadTiming } from '@shared/perf-chat'
import type { ChatMessage, SessionSummary } from '@shared/types'
import { stat } from 'node:fs/promises'
import {
  conversationSessionHints,
  getDisplayBodyEnrichments,
  getMessageRevisions,
  getMessagesForConversation,
  getNativeForkResume,
  listConversationSegments,
  messageRowsToChatMessages,
  threadFamilyIds,
} from '../db/database'
import { compareSessionCopies, listClaudeSessionCopies, claudeCandidateDirs } from '../provider/claude-session-migrate'
import { codexCandidateDirs } from '../provider/codex-session-dirs'
import { scanCodexSessionCopies } from '../projects/session-scanner'
import { loadJsonlCopies } from '../agent/jsonl-cache'
import { createMainLogger } from '../logger'
import { mergeConversationMessages } from '../agent/dedupe-messages'
import { enrichMessagesWithDisplayBody } from '../ipc/enrich-display-body'
import {
  isForkableCanonicalMessage,
  type CanonicalForkMessage,
  type ForkMessageProvenance,
} from './fork-anchor'

const log = createMainLogger('conversations:history')

export interface ConversationHistory {
  messages: ChatMessage[]
  forkMessages: CanonicalForkMessage[]
  familyIds: string[]
  diskMessageCount: number
  databaseMessageCount: number
  timing: ChatLoadTiming
}

export async function loadConversationHistory(
  conversationId: string,
  _projectPath: string,
): Promise<ConversationHistory> {
  const timing: ChatLoadTiming = { readMs: 0, parseMs: 0, diskMs: 0, dbMs: 0, mergeMs: 0, enrichMs: 0, diskBytes: 0, diskLines: 0, cacheHits: 0, prefixSkips: 0 }
  const metadataStart = performance.now()
  const familyIds = threadFamilyIds(conversationId)
  const legacySessionHints = conversationSessionHints(conversationId)
  const segments = listConversationSegments(conversationId)
  const knownSessionIds = new Set([
    ...familyIds,
    ...legacySessionHints,
    ...segments.map((segment) => segment.provider_session_id),
  ])
  const diskMessages: ChatMessage[] = []
  const provenanceByMessageId = new Map<string, ForkMessageProvenance>()
  // The parse cache hands back the same array while a file is unchanged.
  const sources: unknown[] = []

  const claudeIds = new Set([
    ...familyIds,
    ...legacySessionHints,
    ...segments
      .filter((segment) => segment.provider === 'claude-code')
      .map((segment) => segment.provider_session_id),
  ])
  timing.dbMs += performance.now() - metadataStart
  const diskStart = performance.now()
  for (const sessionId of claudeIds) {
    // Profile switches leave older copies that are byte prefixes of the
    // newest one; loadJsonlCopies proves that by hash and parses one.
    const copies = claudeCandidateDirs()
      .flatMap((baseDir) => listClaudeSessionCopies(baseDir, sessionId))
      .sort(compareSessionCopies)
    for (const { messages } of await loadJsonlCopies(copies.map((copy) => copy.path), 'claude-code', timing)) {
      sources.push(messages)
      diskMessages.push(...messages)
      for (const message of messages) {
        provenanceByMessageId.set(message.id, {
          provider: 'claude-code',
          providerSessionId: sessionId,
          providerEventId: message.id,
        })
      }
    }
  }

  const codexSessions = await scanCodexSessionCopies(knownSessionIds, codexCandidateDirs())
  // A native Codex fork's rollout starts with a copy of the parent's prefix,
  // stamped with the fork time; the fork's stored messages already hold it.
  const forkReceipt = codexSessions.length > 0
    ? getNativeForkResume(conversationId)
    : undefined
  for (const [sessionId, paths] of codexCopiesById(codexSessions, knownSessionIds)) {
    // A profile switch copies the rollout to the new CODEX_HOME, so the older
    // copies are byte prefixes of the largest, proven by hash like Claude's.
    const skip = forkReceipt?.provider === 'codex' && forkReceipt.sessionId === sessionId
      ? forkReceipt.copiedMessageCount ?? 0
      : 0
    for (const { messages: loaded } of await loadJsonlCopies(await largestFirst(paths), 'codex', timing)) {
      sources.push(loaded, skip)
      const messages = skip > 0 ? loaded.slice(skip) : loaded
      diskMessages.push(...messages)
      for (const message of messages) {
        provenanceByMessageId.set(message.id, {
          provider: 'codex',
          providerSessionId: sessionId,
          providerEventId: message.id,
        })
      }
    }
  }

  timing.diskMs = performance.now() - diskStart
  const dbStart = performance.now()
  // Read before the rows: a write landing in between leaves the memo one
  // revision behind, so the next open rebuilds instead of trusting it.
  const revisions = getMessageRevisions(familyIds)
  const key = [...familyIds, '\0', ...revisions, '\0', ...sources]
  const memo = mergedHistories.get(conversationId)
  if (memo && sameKey(memo.key, key)) {
    timing.dbMs += performance.now() - dbStart
    timing.mergeHit = true
    mergedHistories.delete(conversationId)
    mergedHistories.set(conversationId, memo)
    return { ...memo.history, timing }
  }
  const databaseMessages = familyIds.flatMap((id) =>
    messageRowsToChatMessages(getMessagesForConversation(id))
  )
  const enrichments = new Map()
  for (const id of familyIds) {
    for (const [content, enrichment] of getDisplayBodyEnrichments(id)) {
      enrichments.set(content, enrichment)
    }
  }
  timing.dbMs += performance.now() - dbStart
  const mergeStart = performance.now()
  const merged = mergeConversationMessages(diskMessages, databaseMessages)
  timing.mergeMs = performance.now() - mergeStart
  const enrichStart = performance.now()
  const messages = enrichMessagesWithDisplayBody(merged, enrichments)
  timing.enrichMs = performance.now() - enrichStart

  const history = {
    messages,
    forkMessages: messages.map((message) => ({
      message,
      forkable: isForkableCanonicalMessage(message),
      ...(provenanceByMessageId.has(message.id)
        ? { provenance: provenanceByMessageId.get(message.id) }
        : {}),
    })),
    familyIds,
    diskMessageCount: diskMessages.length,
    databaseMessageCount: databaseMessages.length,
  }
  rememberMergedHistory(conversationId, key, history)
  return { ...history, timing }
}

// ponytail: bounded by chats and total messages, not bytes. The strings are
// mostly shared with the parse cache; measure retained bytes if this grows.
const MAX_MERGED_HISTORIES = 8
const MAX_MERGED_MESSAGES = 200_000
type MergedHistory = Omit<ConversationHistory, 'timing'>
/** Callers MUST NOT mutate a returned history: it is shared across opens. */
const mergedHistories = new Map<string, { key: unknown[]; history: MergedHistory }>() // insertion order = LRU

function rememberMergedHistory(conversationId: string, key: unknown[], history: MergedHistory): void {
  mergedHistories.delete(conversationId)
  mergedHistories.set(conversationId, { key, history })
  let total = 0
  for (const entry of mergedHistories.values()) total += entry.history.messages.length
  for (const [id, entry] of mergedHistories) {
    if (mergedHistories.size <= MAX_MERGED_HISTORIES && total <= MAX_MERGED_MESSAGES) break
    if (id === conversationId) continue
    mergedHistories.delete(id)
    total -= entry.history.messages.length
  }
}

function sameKey(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** Test seam. */
export function clearMergedHistories(): void {
  mergedHistories.clear()
}

function codexCopiesById(sessions: SessionSummary[], known: ReadonlySet<string>): Map<string, string[]> {
  const byId = new Map<string, string[]>()
  for (const session of sessions) {
    if (!known.has(session.id) || !session.filePath) continue
    byId.set(session.id, [...(byId.get(session.id) ?? []), session.filePath])
  }
  return byId
}

/** Most complete copy first; an unreadable copy goes last and is reported by the loader. */
async function largestFirst(paths: string[]): Promise<string[]> {
  const sized = await Promise.all(paths.map(async (path) => {
    try {
      const st = await stat(path)
      return { path, size: st.size, mtimeMs: st.mtimeMs }
    } catch (err) {
      log.warn('codex rollout stat failed', { path, code: (err as NodeJS.ErrnoException).code })
      return { path, size: -1, mtimeMs: 0 }
    }
  }))
  return sized.sort((a, b) => b.size - a.size || b.mtimeMs - a.mtimeMs).map((copy) => copy.path)
}
