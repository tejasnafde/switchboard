/**
 * Lazy Electron shim so the same modules load under Electron and a headless
 * `node` backend - electron is required only when actually running under it.
 */
import { homedir } from 'os'
import { join } from 'path'
import type { SafeStorage } from 'electron'

export const isElectron = !!process.versions.electron

// Only reached when isElectron; electron is external in both build targets, so
// this require never resolves in a plain-Node process.
function electron(): typeof import('electron') {
  return require('electron')
}

export function userDataDir(): string {
  if (isElectron) return electron().app.getPath('userData')
  return process.env.SWITCHBOARD_DATA_DIR ?? join(homedir(), '.switchboard')
}

export function appRootDir(): string {
  if (isElectron) return electron().app.getAppPath()
  return process.env.SWITCHBOARD_APP_ROOT ?? process.cwd()
}

export function getSafeStorage(): SafeStorage | null {
  return isElectron ? electron().safeStorage : null
}
