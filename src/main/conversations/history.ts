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
  messageWindowRows,
  threadFamilyIds,
} from '../db/database'
import { compareSessionCopies, listClaudeSessionCopies, claudeCandidateDirs } from '../provider/claude-session-migrate'
import { codexCandidateDirs } from '../provider/codex-session-dirs'
import { scanCodexSessionCopies } from '../projects/session-scanner'
import { loadJsonlCopies } from '../agent/jsonl-cache'
import { loadSubagentSteps } from '../agent/subagent-transcripts'
import { createMainLogger } from '../logger'
import { mergeConversationMessages } from '../agent/dedupe-messages'
import { enrichMessagesWithDisplayBody } from '../ipc/enrich-display-body'
import {
  mergeHistoryWindow,
  windowDiskOf,
  type MergedWindow,
  type MergeWindowRequest,
  type WindowDisk,
} from './history-window'
import {
  forgetTranscriptIndex,
  openIndexedCopies,
  StaleTranscriptIndexError,
  type IndexedTranscript,
} from '../agent/transcript-index'
import { isForkableCanonicalMessage, type CanonicalForkMessage, type ForkMessageProvenance } from './fork-anchor'

const log = createMainLogger('conversations:history')

export interface ConversationHistory {
  messages: ChatMessage[]
  forkMessages: CanonicalForkMessage[]
  familyIds: string[]
  diskMessageCount: number
  databaseMessageCount: number
  timing: ChatLoadTiming
}

function emptyTiming(): ChatLoadTiming {
  return {
    readMs: 0,
    parseMs: 0,
    diskMs: 0,
    dbMs: 0,
    mergeMs: 0,
    enrichMs: 0,
    diskBytes: 0,
    diskLines: 0,
    cacheHits: 0,
    prefixSkips: 0,
    hashMs: 0,
    indexHits: 0,
  }
}

interface DiskHistory {
  familyIds: string[]
  diskMessages: ChatMessage[]
  provenanceByMessageId: Map<string, ForkMessageProvenance>
  /** The parse cache hands back the same array while a file is unchanged. */
  sources: unknown[]
}

function sessionIdsOf(conversationId: string) {
  const familyIds = threadFamilyIds(conversationId)
  const legacySessionHints = conversationSessionHints(conversationId)
  const segments = listConversationSegments(conversationId)
  const knownSessionIds = new Set([
    ...familyIds,
    ...legacySessionHints,
    ...segments.map((segment) => segment.provider_session_id),
  ])
  const claudeIds = new Set([
    ...familyIds,
    ...legacySessionHints,
    ...segments.filter((segment) => segment.provider === 'claude-code').map((segment) => segment.provider_session_id),
  ])
  return { familyIds, knownSessionIds, claudeIds }
}

/** Every profile copy of a Claude session, most complete first. */
function claudeCopyPaths(sessionId: string): string[] {
  return claudeCandidateDirs()
    .flatMap((baseDir) => listClaudeSessionCopies(baseDir, sessionId))
    .sort(compareSessionCopies)
    .map((copy) => copy.path)
}

async function loadDiskHistory(conversationId: string, timing: ChatLoadTiming): Promise<DiskHistory> {
  const metadataStart = performance.now()
  const { familyIds, knownSessionIds, claudeIds } = sessionIdsOf(conversationId)
  const diskMessages: ChatMessage[] = []
  const provenanceByMessageId = new Map<string, ForkMessageProvenance>()
  const sources: unknown[] = []
  timing.dbMs += performance.now() - metadataStart
  const diskStart = performance.now()
  for (const sessionId of claudeIds) {
    // Profile switches leave older copies that are byte prefixes of the
    // newest one; loadJsonlCopies proves that by hash and parses one.
    const paths = claudeCopyPaths(sessionId)
    for (const { messages } of await loadJsonlCopies(paths, 'claude-code', timing)) {
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
    // A subagent's steps live in transcripts of their own, beside the session's.
    diskMessages.push(...(await loadSubagentSteps(paths, timing, sources)))
  }

  const codexSessions = await scanCodexSessionCopies(knownSessionIds, codexCandidateDirs())
  // A native Codex fork's rollout starts with a copy of the parent's prefix,
  // stamped with the fork time; the fork's stored messages already hold it.
  const forkReceipt = codexSessions.length > 0 ? getNativeForkResume(conversationId) : undefined
  for (const [sessionId, paths] of codexCopiesById(codexSessions, knownSessionIds)) {
    // A profile switch copies the rollout to the new CODEX_HOME, so the older
    // copies are byte prefixes of the largest, proven by hash like Claude's.
    const skip =
      forkReceipt?.provider === 'codex' && forkReceipt.sessionId === sessionId
        ? (forkReceipt.copiedMessageCount ?? 0)
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
  return { familyIds, diskMessages, provenanceByMessageId, sources }
}

export async function loadConversationHistory(
  conversationId: string,
  _projectPath: string,
): Promise<ConversationHistory> {
  const timing = emptyTiming()
  const { familyIds, diskMessages, provenanceByMessageId, sources } = await loadDiskHistory(conversationId, timing)
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
  const databaseMessages = familyIds.flatMap((id) => messageRowsToChatMessages(getMessagesForConversation(id)))
  const enrichments = displayBodyEnrichments(familyIds)
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
      ...(provenanceByMessageId.has(message.id) ? { provenance: provenanceByMessageId.get(message.id) } : {}),
    })),
    familyIds,
    diskMessageCount: diskMessages.length,
    databaseMessageCount: databaseMessages.length,
  }
  rememberMergedHistory(conversationId, key, history)
  return { ...history, timing }
}

export interface ConversationHistoryWindow extends Omit<MergedWindow, 'rowsRead'> {
  familyIds: string[]
  diskMessageCount: number
  databaseMessageCount: number
  timing: ChatLoadTiming
}

/**
 * One window of the merged history, read without the full history: each
 * transcript through its byte-offset index (`transcript-index.ts`), so only
 * the lines near the window are parsed, and SQLite rows only near the window
 * (see `mergeHistoryWindow`). Every older page costs the same.
 */
export async function loadConversationHistoryWindow(
  conversationId: string,
  request: MergeWindowRequest,
): Promise<ConversationHistoryWindow> {
  try {
    return await loadWindow(conversationId, request, true)
  } catch (err) {
    if (!(err instanceof StaleTranscriptIndexError)) throw err
    log.warn('transcript index did not match its file, parsing it in full', { conversationId })
    await forgetTranscriptIndex(err.path, err.source)
    return loadWindow(conversationId, request, false)
  }
}

async function loadWindow(
  conversationId: string,
  request: MergeWindowRequest,
  indexed: boolean,
): Promise<ConversationHistoryWindow> {
  const timing = emptyTiming()
  const { familyIds, disk } = indexed
    ? await loadIndexedDisk(conversationId, timing)
    : await loadDiskHistory(conversationId, timing).then((history) => ({
        familyIds: history.familyIds,
        disk: windowDiskOf(history.diskMessages),
      }))
  const start = performance.now()
  let readMs = 0
  const rows = messageWindowRows(familyIds, (ms) => (readMs += ms))
  const diskBefore = { readMs: timing.readMs, parseMs: timing.parseMs }
  const { rowsRead, ...window } = mergeHistoryWindow(disk, rows, request)
  // Materializing the window's transcript lines happens inside the merge.
  const sliceMs = timing.readMs - diskBefore.readMs + timing.parseMs - diskBefore.parseMs
  timing.diskMs += sliceMs
  const enrichStart = performance.now()
  timing.dbMs += readMs
  timing.mergeMs = enrichStart - start - readMs - sliceMs
  const enrichments = displayBodyEnrichments(familyIds, userContents(window.messages))
  const messages = enrichMessagesWithDisplayBody(window.messages, enrichments)
  timing.enrichMs = performance.now() - enrichStart
  return {
    ...window,
    messages,
    familyIds,
    diskMessageCount: disk.metas.length,
    databaseMessageCount: rowsRead,
    timing,
  }
}

/**
 * The transcripts `loadDiskHistory` reads, in the same order, as a lazy view:
 * indexed copies give ids and times, and parse lines only when materialized.
 * A copy set that cannot be indexed is parsed in full, as before.
 */
async function loadIndexedDisk(
  conversationId: string,
  timing: ChatLoadTiming,
): Promise<{ familyIds: string[]; disk: WindowDisk }> {
  const metadataStart = performance.now()
  const { familyIds, knownSessionIds, claudeIds } = sessionIdsOf(conversationId)
  timing.dbMs += performance.now() - metadataStart
  const diskStart = performance.now()
  const parts: WindowDisk[] = []
  const addCopies = async (paths: string[], source: 'claude-code' | 'codex', skip = 0) => {
    const indexed = await openIndexedCopies(paths, source, timing)
    if (indexed) {
      for (const transcript of indexed) parts.push(skipped(transcriptDisk(transcript), skip))
      return
    }
    for (const { messages } of await loadJsonlCopies(paths, source, timing)) {
      parts.push(windowDiskOf(skip > 0 ? messages.slice(skip) : messages))
    }
  }
  for (const sessionId of claudeIds) {
    const paths = claudeCopyPaths(sessionId)
    await addCopies(paths, 'claude-code')
    parts.push(windowDiskOf(await loadSubagentSteps(paths, timing, [])))
  }
  const codexSessions = await scanCodexSessionCopies(knownSessionIds, codexCandidateDirs())
  const forkReceipt = codexSessions.length > 0 ? getNativeForkResume(conversationId) : undefined
  for (const [sessionId, paths] of codexCopiesById(codexSessions, knownSessionIds)) {
    const skip =
      forkReceipt?.provider === 'codex' && forkReceipt.sessionId === sessionId
        ? (forkReceipt.copiedMessageCount ?? 0)
        : 0
    await addCopies(await largestFirst(paths), 'codex', skip)
  }
  timing.diskMs = performance.now() - diskStart
  return { familyIds, disk: concatDisks(parts) }
}

function transcriptDisk(transcript: IndexedTranscript): WindowDisk {
  return { metas: transcript.messages, materialize: transcript.materialize }
}

/** Drop the first `skip` messages, as `loadDiskHistory` slices a native fork's copied prefix. */
function skipped(disk: WindowDisk, skip: number): WindowDisk {
  if (skip <= 0) return disk
  return {
    metas: disk.metas.slice(skip),
    materialize: (positions) => disk.materialize(positions.map((at) => at + skip)),
  }
}

function concatDisks(parts: WindowDisk[]): WindowDisk {
  if (parts.length === 1) return parts[0]
  const starts: number[] = []
  const metas: WindowDisk['metas'][number][] = []
  for (const part of parts) {
    starts.push(metas.length)
    metas.push(...part.metas)
  }
  return {
    metas,
    materialize: (positions) => {
      const byPart = new Map<number, number[]>()
      for (const at of positions) {
        let part = starts.length - 1
        while (starts[part] > at) part--
        const list = byPart.get(part)
        if (list) list.push(at)
        else byPart.set(part, [at])
      }
      const found = new Map<number, ChatMessage>()
      for (const [part, list] of byPart) {
        const messages = parts[part].materialize(list.map((at) => at - starts[part]))
        list.forEach((at, index) => found.set(at, messages[index]))
      }
      return positions.map((at) => found.get(at)!)
    },
  }
}

function displayBodyEnrichments(familyIds: readonly string[], contents?: ReadonlySet<string>) {
  const enrichments = new Map()
  for (const id of familyIds) {
    for (const [content, enrichment] of getDisplayBodyEnrichments(id, contents)) enrichments.set(content, enrichment)
  }
  return enrichments
}

function userContents(messages: readonly ChatMessage[]): Set<string> {
  return new Set(messages.filter((message) => message.role === 'user').map((message) => message.content))
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

/** The last merged history of a conversation, unchecked: only for rows that do not change. */
export function mergedHistoryMessages(conversationId: string): ChatMessage[] | undefined {
  return mergedHistories.get(conversationId)?.history.messages
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
  const sized = await Promise.all(
    paths.map(async (path) => {
      try {
        const st = await stat(path)
        return { path, size: st.size, mtimeMs: st.mtimeMs }
      } catch (err) {
        log.warn('codex rollout stat failed', { path, code: (err as NodeJS.ErrnoException).code })
        return { path, size: -1, mtimeMs: 0 }
      }
    }),
  )
  return sized.sort((a, b) => b.size - a.size || b.mtimeMs - a.mtimeMs).map((copy) => copy.path)
}
