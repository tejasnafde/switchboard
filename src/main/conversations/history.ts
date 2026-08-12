import type { ChatMessage } from '@shared/types'
import {
  conversationSessionHints,
  getDisplayBodyEnrichments,
  getMessagesForConversation,
  listConversationSegments,
  messageRowsToChatMessages,
  threadFamilyIds,
} from '../db/database'
import { listClaudeSessionCopies, claudeCandidateDirs } from '../provider/claude-session-migrate'
import { codexCandidateDirs } from '../provider/codex-session-dirs'
import { scanCodexSessionCopies } from '../projects/session-scanner'
import { loadJsonlCached } from '../agent/jsonl-cache'
import { mergeConversationMessages } from '../agent/dedupe-messages'
import { enrichMessagesWithDisplayBody } from '../ipc/enrichDisplayBody'

export interface ConversationHistory {
  messages: ChatMessage[]
  familyIds: string[]
  diskMessageCount: number
  databaseMessageCount: number
}

export async function loadConversationHistory(
  conversationId: string,
  _projectPath: string,
): Promise<ConversationHistory> {
  const familyIds = threadFamilyIds(conversationId)
  const legacySessionHints = conversationSessionHints(conversationId)
  const segments = listConversationSegments(conversationId)
  const knownSessionIds = new Set([
    ...familyIds,
    ...legacySessionHints,
    ...segments.map((segment) => segment.provider_session_id),
  ])
  const diskMessages: ChatMessage[] = []

  const claudeIds = new Set([
    ...familyIds,
    ...legacySessionHints,
    ...segments
      .filter((segment) => segment.provider === 'claude-code')
      .map((segment) => segment.provider_session_id),
  ])
  for (const sessionId of claudeIds) {
    for (const baseDir of claudeCandidateDirs()) {
      for (const copy of listClaudeSessionCopies(baseDir, sessionId)) {
        const messages = await loadJsonlCached(copy.path, 'claude-code')
        if (messages) diskMessages.push(...messages)
      }
    }
  }

  const codexSessions = await scanCodexSessionCopies(knownSessionIds, codexCandidateDirs())
  for (const session of codexSessions) {
    if (!knownSessionIds.has(session.id) || !session.filePath) continue
    const messages = await loadJsonlCached(session.filePath, 'codex')
    if (messages) diskMessages.push(...messages)
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
  const messages = enrichMessagesWithDisplayBody(
    mergeConversationMessages(diskMessages, databaseMessages),
    enrichments,
  )

  return {
    messages,
    familyIds,
    diskMessageCount: diskMessages.length,
    databaseMessageCount: databaseMessages.length,
  }
}
