/**
 * Pure visibility rule for the app-level update toast. A downloaded update
 * stays on screen through later statuses (a check, a failed check), because
 * it is still installed by a restart. "Later" hides it until main reports the
 * download again: the hourly check does, and so does a newer version.
 */
import type { UpdateStatus } from '@shared/update-status'

export interface UpdateToastState {
  version: string | null
  visible: boolean
}

export const hiddenUpdateToast: UpdateToastState = { version: null, visible: false }

export function updateToastAfter(state: UpdateToastState, status: UpdateStatus): UpdateToastState {
  return status.kind === 'downloaded' ? { version: status.version, visible: true } : state
}
