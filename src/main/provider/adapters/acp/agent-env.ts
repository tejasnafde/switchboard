/**
 * Binary lookup and spawn env for the generic ACP agents. OpenCode keeps its
 * own (`../opencode/env.ts`), which also injects API keys from Settings.
 */
import { execFileSync } from 'child_process'
import { accessSync, constants } from 'fs'
import { delimiter, join } from 'path'
import { createMainLogger } from '../../../logger'
import { peekShellEnv } from '../../../shell-env'

const log = createMainLogger('provider:acp:env')

/** A miss is re-checked after this long, so a fresh install shows up without a relaunch. */
const MISS_TTL_MS = 30_000

const found = new Map<string, string>()
const missedAt = new Map<string, number>()

/** Directories npm, brew, uv, pipx, volta and bun install agent CLIs into. */
export function agentBinaryCandidates(name: string, home: string): string[] {
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
  ].map((dir) => join(dir, name))
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch (err) {
    log.debug(`no executable at ${path}`, err)
    return false
  }
}

/**
 * Absolute path of `name`: the usual install directories first, then `which`
 * on the login shell's PATH (a packaged app's own PATH misses nvm and the
 * like). Null when not installed.
 */
export function findAgentBinary(name: string, now = Date.now()): string | null {
  const hit = found.get(name)
  if (hit) return hit
  const missed = missedAt.get(name)
  if (missed !== undefined && now - missed < MISS_TTL_MS) return null

  const home = process.env.HOME || ''
  let path = agentBinaryCandidates(name, home).find(isExecutable) ?? null
  if (!path) {
    const PATH = peekShellEnv()?.PATH ?? process.env.PATH ?? ''
    try {
      const which = process.platform === 'win32' ? 'where' : '/usr/bin/which'
      path = execFileSync(which, [name], { encoding: 'utf-8', timeout: 5000, env: { ...process.env, PATH } }).trim().split(/\r?\n/)[0] || null
    } catch (err) {
      log.debug(`${name} not found on PATH`, err)
    }
  }
  if (path) {
    found.set(name, path)
    missedAt.delete(name)
  } else {
    missedAt.set(name, now)
  }
  return path
}

/**
 * Spawn env, later layers winning: login shell env, process env, the instance
 * overlay. PATH is the login shell's first, then the process's, so an agent
 * found through the shell also finds its interpreter (node, python).
 */
export function buildAgentEnv(overlay: Record<string, string>): Record<string, string> {
  const shellEnv = peekShellEnv()
  const PATH = [shellEnv?.PATH, process.env.PATH].filter(Boolean).join(delimiter)
  return {
    ...(shellEnv ?? {}),
    ...(process.env as Record<string, string>),
    ...(PATH ? { PATH } : {}),
    ...overlay,
  }
}

export function _resetAgentBinaryCacheForTests(): void {
  found.clear()
  missedAt.clear()
}
