import type { UpdateStatus } from '@shared/update-status'

/**
 * Pure view-model for the Settings → Updates row. Extracted from
 * SettingsModal so the button-state rules (idempotency guards, pending
 * labels) are unit-testable without a DOM.
 */
export interface UpdateRowView {
  showRestart: boolean
  restartDisabled: boolean
  restartSpinning: boolean
  restartLabel: string
  checkDisabled: boolean
}

/**
 * Status line copy. Annotated `: string` on purpose - a new UpdateStatus kind
 * then fails typecheck here instead of silently rendering a blank line.
 */
export function updateStatusLabel(status: UpdateStatus): string {
  switch (status.kind) {
    case 'idle': return 'Idle.'
    case 'checking': return 'Checking…'
    case 'up-to-date': return `You're on the latest version (${status.version}).`
    case 'available': return `Update available - downloading ${status.version}…`
    case 'downloading': return `Downloading… ${status.percent}%`
    case 'downloaded': return `Update ready: ${status.version}. Restart to install.`
    case 'installing': return 'Restarting to install the update…'
    case 'error': return `Couldn't check: ${status.message}`
    case 'unsupported': return status.reason
  }
}

export function updateRowView(
  status: UpdateStatus,
  flags: { checking: boolean; restarting: boolean },
): UpdateRowView {
  // `installing` comes from main, which latches the request globally, so the
  // pending state survives a Settings remount that clears the local flag.
  const restarting = flags.restarting || status.kind === 'installing'
  return {
    showRestart: status.kind === 'downloaded' || status.kind === 'installing',
    restartDisabled: restarting,
    restartSpinning: restarting,
    restartLabel: restarting ? 'Restarting…' : 'Restart and install',
    checkDisabled:
      flags.checking ||
      restarting ||
      status.kind === 'checking' ||
      status.kind === 'downloading',
  }
}
