import type { ChatLoadTiming } from '@shared/perf-chat'
import type { ChatMessage } from '@shared/types'
import {
  conversationSessionHints,
  getDisplayBodyEnrichments,
  getMessagesForConversation,
  getNativeForkResume,
  listConversationSegments,
  messageRowsToChatMessages,
  threadFamilyIds,
} from '../db/database'
import { compareSessionCopies, listClaudeSessionCopies, claudeCandidateDirs } from '../provider/claude-session-migrate'
import { codexCandidateDirs } from '../provider/codex-session-dirs'
import { scanCodexSessionCopies } from '../projects/session-scanner'
import { loadJsonlCached, loadJsonlCopies } from '../agent/jsonl-cache'
import { mergeConversationMessages } from '../agent/dedupe-messages'
import { enrichMessagesWithDisplayBody } from '../ipc/enrich-display-body'
import {
  isForkableCanonicalMessage,
  type CanonicalForkMessage,
  type ForkMessageProvenance,
} from './fork-anchor'

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
  for (const session of codexSessions) {
    if (!knownSessionIds.has(session.id) || !session.filePath) continue
    const loaded = await loadJsonlCached(session.filePath, 'codex', timing)
    const messages = loaded && forkReceipt?.provider === 'codex' && forkReceipt.sessionId === session.id
      ? loaded.slice(forkReceipt.copiedMessageCount ?? 0)
      : loaded
    if (messages) {
      diskMessages.push(...messages)
      for (const message of messages) {
        provenanceByMessageId.set(message.id, {
          provider: 'codex',
          providerSessionId: session.id,
          providerEventId: message.id,
        })
      }
    }
  }

  timing.diskMs = performance.now() - diskStart
  const dbStart = performance.now()
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

  return {
    timing,
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
}
