/**
 * Desktop glue for `settings.json` (`main/settings-file.ts`): reads the DB
 * snapshot, applies a save through the same write paths the settings IPC
 * uses, and serves the Settings row. On ipcMain only, never on the backend
 * host, so neither a phone nor a remote window can reach it.
 */
import { app, ipcMain, shell, type BrowserWindow } from 'electron'
import { SettingsFileChannels } from '@shared/ipc-channels'
import {
  FILE_SETTINGS,
  SETTINGS_FILE_SYNCED_HASH_KEY,
  type SettingsFileOp,
  type SettingsSnapshot,
} from '@shared/settings-file'
import { KEYBOARD_OVERRIDES_SETTING } from '@shared/shortcuts'
import {
  PROJECT_OVERRIDE_PREFIX,
  isScopableSetting,
  parseProjectOverrideKey,
  projectOverrideKey,
} from '@shared/project-settings'
import { getProjects, getSetting, listSettingsWithPrefix, removeSetting, setSetting } from '../db/database'
import { removeProjectOverride, setProjectOverride } from '../project-settings'
import { pathKey } from '../worktree'
import { SettingsFileSync } from '../settings-file'
import { createMainLogger } from '../logger'

const log = createMainLogger('settings:file')

function readSnapshot(): SettingsSnapshot {
  const settings: Record<string, string> = {}
  for (const { key } of FILE_SETTINGS) {
    const value = getSetting(key)
    if (value !== null) settings[key] = value
  }
  const projects: Record<string, Record<string, string>> = {}
  for (const { key, value } of listSettingsWithPrefix(PROJECT_OVERRIDE_PREFIX)) {
    const parsed = parseProjectOverrideKey(key)
    if (!parsed || !isScopableSetting(parsed.settingKey)) continue
    ;(projects[parsed.projectKey] ??= {})[parsed.settingKey] = value
  }
  let keyboard: Record<string, unknown> = {}
  const raw = getSetting(KEYBOARD_OVERRIDES_SETTING)
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) keyboard = parsed as Record<string, unknown>
  } catch (err) {
    log.warn('stored shortcut overrides are not JSON; the file shows none', err)
  }
  return { settings, projects, keyboard }
}

/** A stored project key spelled as the project list spells it, when one matches. */
function projectLabel(projectKey: string): string {
  return getProjects().find((p) => pathKey(p.path) === projectKey)?.path ?? projectKey
}

/** One write through the path the settings IPC uses; answers the stored key it wrote. */
function applyOp(op: SettingsFileOp): string {
  switch (op.kind) {
    case 'set':
      setSetting(op.key, op.value)
      return op.key
    case 'remove':
      removeSetting(op.key)
      return op.key
    case 'project-set':
      setProjectOverride(op.projectPath, op.key, op.value)
      return projectOverrideKey(pathKey(op.projectPath), op.key)
    case 'project-remove':
      removeProjectOverride(op.projectKey, op.key)
      return projectOverrideKey(op.projectKey, op.key)
    case 'keyboard':
      setSetting(KEYBOARD_OVERRIDES_SETTING, op.value)
      return KEYBOARD_OVERRIDES_SETTING
  }
}

export interface SettingsFileHostDeps {
  getWindow: () => BrowserWindow | null
  /** The same hook the settings IPC calls after a write (menu rebuild for rebinds). */
  onSettingChanged: (key: string) => void
}

let sync: SettingsFileSync | null = null

export function settingsFileSync(): SettingsFileSync | null {
  return sync
}

/** Quit: stop watching settings.json. Safe to call more than once. */
export function disposeSettingsFileSync(): void {
  const current = sync
  sync = null
  current?.dispose()
}

export function registerSettingsFileHandlers(deps: SettingsFileHostDeps): SettingsFileSync {
  const send = (channel: string, ...args: unknown[]) => {
    const window = deps.getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, ...args)
  }

  const applyOps = (ops: SettingsFileOp[]): string[] => {
    const changed: string[] = []
    for (const op of ops) {
      try {
        const key = applyOp(op)
        changed.push(key)
        deps.onSettingChanged(key)
      } catch (err) {
        log.warn(`applying ${op.kind} from settings.json failed`, err)
      }
    }
    if (changed.length > 0) send(SettingsFileChannels.APPLIED, changed)
    return changed
  }

  sync?.dispose()
  const created = new SettingsFileSync({
    dir: app.getPath('userData'),
    readSnapshot,
    projectLabel,
    projectKey: pathKey,
    applyOps,
    onStatus: (status) => send(SettingsFileChannels.STATUS_CHANGED, status),
    syncedHash: {
      load: () => getSetting(SETTINGS_FILE_SYNCED_HASH_KEY),
      save: (hash) => setSetting(SETTINGS_FILE_SYNCED_HASH_KEY, hash),
    },
    log,
  })
  sync = created
  void created.resume().catch((err) => log.warn('resuming settings.json sync failed', err))

  ipcMain.removeHandler(SettingsFileChannels.OPEN)
  ipcMain.removeHandler(SettingsFileChannels.OPEN_EXTERNAL)
  ipcMain.removeHandler(SettingsFileChannels.STATUS)
  ipcMain.handle(SettingsFileChannels.OPEN, async () => ({ path: await created.open() }))
  ipcMain.handle(SettingsFileChannels.OPEN_EXTERNAL, async () => {
    // shell.openPath resolves to '' on success and to an error string otherwise.
    const error = await shell.openPath(created.path)
    if (error) log.warn('opening settings.json in the system editor failed', { error })
    return { ok: !error, error: error || undefined }
  })
  ipcMain.handle(SettingsFileChannels.STATUS, () => created.getStatus())
  return created
}
