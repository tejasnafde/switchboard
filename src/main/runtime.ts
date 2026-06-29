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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function electron(): any {
  // require() stays unevaluated under Node since isElectron gates every call;
  // electron is marked external in both build targets.
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
