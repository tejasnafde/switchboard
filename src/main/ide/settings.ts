/**
 * Couples the embedded workbench to Switchboard. code-server live-applies
 * changes to its User/settings.json, so writing that file IS the whole
 * integration: theme follows the app theme, and first-run defaults make the
 * workbench feel native (autosave on, no welcome tab, no trust popup).
 * Existing user settings are never clobbered - defaults seed once, only the
 * explicitly-patched keys are overwritten after that.
 */

export const SEEDED_DEFAULTS: Record<string, unknown> = {
  'files.autoSave': 'afterDelay',
  'workbench.startupEditor': 'none',
  'security.workspace.trust.enabled': false,
  'telemetry.telemetryLevel': 'off',
  // The Copilot-chat secondary sidebar overlaps the editor in a narrow pane
  // and Switchboard IS the chat surface - keep the workbench editor-first.
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'chat.commandCenter.enabled': false,
}

export function themeToColorTheme(theme: string): string {
  // Charcoal ships inside sb-bridge and mirrors the app's own dark palette.
  return theme === 'light' ? 'Default Light Modern' : 'Switchboard Charcoal'
}

/**
 * Merge `patch` into the existing settings JSON. Defaults BACKFILL absent
 * keys on every merge - a key the user has ever set (to anything) always
 * wins, but defaults added in later app versions still reach existing
 * installs (seed-once left early adopters with recurring workbench banners
 * the newer defaults suppress). Returns null when the existing file is
 * present but unparseable: VS Code settings are JSONC and users hand-edit
 * comments in, so replacing an unreadable file with defaults would destroy
 * their settings - callers skip the write.
 */
export function mergeUserSettings(existingJson: string | null, patch: Record<string, unknown>): string | null {
  let existing: Record<string, unknown> | null = null
  if (existingJson !== null) {
    try {
      existing = JSON.parse(existingJson)
    } catch {
      return null
    }
    if (!existing || typeof existing !== 'object') return null
  }
  return JSON.stringify({ ...SEEDED_DEFAULTS, ...(existing ?? {}), ...patch }, null, 2)
}
