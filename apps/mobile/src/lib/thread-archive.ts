/**
 * Archiving a chat from its agent settings sheet. Native Android applies the
 * same rules (`ThreadArchivePolicy`, `ThreadSessionCoordinator.archive`).
 */
import type { ProviderSessionStatus } from '@shared/provider-events'

/** A chat is archived only while no turn runs or starts. */
export function canArchive(status: ProviderSessionStatus, archiving: boolean): boolean {
  return !archiving && (status === 'idle' || status === 'error' || status === 'stopped')
}

/** Null when the backend confirmed the archive, else the message to show. */
export function archiveFailure(
  result: { ok: boolean; archived?: boolean; error?: string } | null | undefined,
): string | null {
  if (result?.ok && result.archived) return null
  return result?.error?.trim() || 'Backend did not confirm the archive'
}
