/**
 * Pure visibility rule for the app-level update toast. The toast shows
 * only once an update is fully downloaded, and "Later" dismisses it for
 * that version only - a newer download during the same session re-shows
 * the toast.
 */
import type { UpdateStatus } from '@shared/update-status'

export function shouldShowUpdateToast(
  status: UpdateStatus,
  dismissedVersion: string | null,
): boolean {
  return status.kind === 'downloaded' && status.version !== dismissedVersion
}
