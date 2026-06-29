/**
 * Environment shim for code that must run both inside the Electron main process
 * and in a headless `node server.js` backend. Electron APIs are reached lazily
 * (only when actually running under Electron) so importing this module never
 * pulls `electron` into a plain-Node process.
 *
 *   userDataDir() — DB / app-support root
 *   appRootDir()  — repo/app root for resolving bundled binaries (LSP servers)
 *   getSafeStorage() — Electron keychain crypto, or null when headless
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
