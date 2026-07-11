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
  return theme === 'light' ? 'Default Light Modern' : 'Default Dark Modern'
}

/**
 * Merge `patch` into the existing settings JSON (defaults only when starting
 * fresh). Returns null when the existing file is present but unparseable:
 * VS Code settings are JSONC and users hand-edit comments in, so replacing an
 * unreadable file with defaults would destroy their settings. Callers skip
 * the write (live changes still land via the bridge config push).
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
  const base = existing ?? { ...SEEDED_DEFAULTS }
  return JSON.stringify({ ...base, ...patch }, null, 2)
}
