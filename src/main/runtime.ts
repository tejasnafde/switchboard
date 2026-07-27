/**
 * Lazy Electron shim so the same modules load under Electron and a headless
 * `node` backend - electron is required only when actually running under it.
 */
import { homedir } from 'os'
import { join } from 'path'
import type { SafeStorage } from 'electron'

/**
 * True only in a REAL Electron runtime, where app/safeStorage exist.
 *
 * process.versions.electron is also set under ELECTRON_RUN_AS_NODE, where the
 * electron module exports no runtime APIs at all - so testing that alone sent
 * this shim down the Electron branch and blew up on `app.getPath` being
 * undefined. That mode is not hypothetical: `npm run server` uses it so the
 * native modules match the ABI `npm run rebuild` produced, and Claude Code's
 * shell sets it too (hence `dev` unsetting it).
 */
export const isElectron = !!process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE

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

export function appVersion(): string {
  if (isElectron) return electron().app.getVersion()
  return process.env.npm_package_version ?? '0.0.0'
}
