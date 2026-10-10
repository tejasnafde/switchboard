export type ConversationSidebarRole = 'managed' | 'recovery'

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
  return nativeConversationTitle?.trim() || rootConversationTitle?.trim() || scannerTitle
}
