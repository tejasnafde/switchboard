/**
 * Couples the embedded workbench to Switchboard. code-server live-applies
 * changes to its User/settings.json, so writing that file IS the whole
 * integration: theme follows the app theme, and first-run defaults make the
 * workbench feel native (autosave on, no welcome tab, no trust popup).
 * Existing user settings are never clobbered - defaults seed once, only the
 * explicitly-patched keys are overwritten after that.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileSafe } from '../files/writing'

export const SEEDED_DEFAULTS: Record<string, unknown> = {
  'files.autoSave': 'afterDelay',
  'workbench.startupEditor': 'none',
  'security.workspace.trust.enabled': false,
  'telemetry.telemetryLevel': 'off',
  // The Copilot-chat secondary sidebar overlaps the editor in a narrow pane
  // and Switchboard IS the chat surface - keep the workbench editor-first.
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'chat.commandCenter.enabled': false,
  // Third-party extensions (Atlassian, etc.) auto-pop a "Get started"
  // walkthrough on activation, stealing the viewlet away from the file
  // explorer. Suppress it - the workbench is embedded, not a fresh install.
  'workbench.welcomePage.walkthroughs.openOnInstall': false,
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

/**
 * Read, merge and write the workbench's settings.json. Shared by the local
 * workbench (ipc/ide.ts) and a remote one (ide/bridge-host.ts) so both agree on
 * the two rules that matter: never clobber unparseable JSONC, and never let
 * code-server's file watcher observe a torn write.
 */
export async function patchWorkbenchSettings(
  settingsPath: string,
  patch: Record<string, unknown>,
  log: { warn(msg: string, err?: unknown): void },
): Promise<void> {
  mkdirSync(join(settingsPath, '..'), { recursive: true })
  let existing: string | null = null
  try {
    existing = readFileSync(settingsPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('settings read failed', err)
  }
  const merged = mergeUserSettings(existing, patch)
  if (merged === null) {
    // Unparseable (JSONC hand edits) - never clobber; a bridge push still
    // applies live changes through the workbench's own config service.
    log.warn(`settings.json unparseable - skipping file write: ${settingsPath}`)
    return
  }
  const res = await writeFileSafe(settingsPath, merged, {})
  if (!res.ok) log.warn('settings write failed', res.error)
}
