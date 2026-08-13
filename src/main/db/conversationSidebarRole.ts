export type ConversationSidebarRole = 'managed' | 'recovery'

export interface LegacyConversationEvidence {
  id: string
  messageCount?: number
  segmentCount?: number
  referenceCount?: number
  /** Pane state is written by merely opening a scanner row; never ownership. */
  layoutCount?: number
  threadChildCount?: number
  forkedAtMessageId?: string | null
}

/** Conservative one-time classification for rows created by the old scanner. */
export function classifyLegacyConversationSidebarRole(
  evidence: LegacyConversationEvidence,
): ConversationSidebarRole {
  if (evidence.id.startsWith('agent_')) return 'managed'
  if ((evidence.messageCount ?? 0) > 0) return 'managed'
  if ((evidence.segmentCount ?? 0) > 0) return 'managed'
  if ((evidence.referenceCount ?? 0) > 0) return 'managed'
  if ((evidence.threadChildCount ?? 0) > 0) return 'managed'
  if (evidence.forkedAtMessageId) return 'managed'
  return 'recovery'
}

export function logicalImportConversationId(
  nativeSessionId: string,
  resolvedRootId: string,
  delegated: boolean,
  promotedId: string,
): string {
  if (delegated) return promotedId
  return resolvedRootId || nativeSessionId
}

/** Preserve a user-assigned native title across scanner fallback names. */
export function recoveryCandidateTitle(
  scannerTitle: string,
  nativeConversationTitle: string | null,
  rootConversationTitle: string | null,
): string {
  return nativeConversationTitle?.trim()
    || rootConversationTitle?.trim()
    || scannerTitle
}
