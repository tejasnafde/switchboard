import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'
import { createMainLogger } from './logger'

const log = createMainLogger('shell-env')

let cachedShellEnv: Record<string, string> | null | undefined

/** Read the environment a user gets in their login shell. */
export function loadShellEnv(): Record<string, string> | null {
  if (cachedShellEnv !== undefined) return cachedShellEnv
  if (process.platform === 'win32') {
    cachedShellEnv = null
    return null
  }
  const shell = process.env.SHELL || '/bin/sh'
  const name = basename(shell).toLowerCase()
  if (name === 'nu' || name === 'nu.exe') {
    cachedShellEnv = null
    return null
  }
  const probe = (flag: '-il' | '-l'): Record<string, string> | null => {
    const out = spawnSync(shell, [flag, '-c', 'env -0'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    })
    if (out.error || out.status !== 0) return null
    const env: Record<string, string> = {}
    for (const line of out.stdout.toString('utf8').split('\0')) {
      if (!line) continue
      const separator = line.indexOf('=')
      if (separator <= 0) continue
      env[line.slice(0, separator)] = line.slice(separator + 1)
    }
    return Object.keys(env).length > 0 ? env : null
  }
  cachedShellEnv = probe('-il') ?? probe('-l')
  if (!cachedShellEnv) log.warn('login-shell environment probe failed')
  return cachedShellEnv
}

/** Preserve the app environment, replacing only Finder's truncated PATH. */
export function childProcessEnv(): NodeJS.ProcessEnv {
  const path = loadShellEnv()?.PATH
  return path ? { ...process.env, PATH: path } : process.env
}

/** Clear the process-wide cache between unit-test environments. */
export function _resetShellEnvCacheForTests(): void {
  cachedShellEnv = undefined
}
