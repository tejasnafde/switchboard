/**
 * The environment a user gets in their LOGIN shell, which a Finder-launched
 * Electron app never inherits (Finder hands it a truncated PATH, and the
 * remote backend's non-interactive ssh PATH omits ~/.local/bin altogether).
 * Provider discovery needs it to find a `codex`/`opencode` that only the
 * user's profile knows about.
 *
 * Getting it means starting an interactive login shell, which sources the
 * user's whole profile - nvm, pyenv, conda, corporate shell frameworks. That
 * routinely takes seconds. So the probe is asynchronous and process-wide:
 *
 *   - `peekShellEnv()` is the one hot paths use. It NEVER blocks: cold, it
 *     returns null and schedules the probe; warm, it returns the cached env.
 *     A caller that misses simply proceeds without the extra PATH entries -
 *     the managed bin dir and the built-in fallback dirs still resolve the
 *     common installs immediately - and the next lookup, once the warmup has
 *     landed, sees the full PATH. (Both executable caches revalidate, so a
 *     tool found only via the shell PATH does get picked up.)
 *   - `warmShellEnv()` runs that probe once, shared by every concurrent
 *     caller, and can be kicked off at boot.
 *   - `loadShellEnv()` is the legacy synchronous form, kept for the
 *     machine-connect/provision paths that spawn ssh and genuinely cannot
 *     proceed without a PATH. It answers from the same cache, so once the
 *     warmup has landed it never spawns at all.
 */
import { execFile, spawnSync } from 'node:child_process'
import { basename } from 'node:path'
import { createMainLogger } from './logger'

const log = createMainLogger('shell-env')

/** `undefined` = never probed, `null` = probed and unavailable. */
let cachedShellEnv: Record<string, string> | null | undefined
/** The single in-flight async probe, so concurrent callers share one child. */
let warmupInFlight: Promise<Record<string, string> | null> | null = null

const PROBE_FLAGS = ['-il', '-l'] as const
const PROBE_TIMEOUT_MS = 5000

/** Shells this probe cannot use: no POSIX `env -0`, or no shell at all. */
function unsupportedShell(shell: string): boolean {
  if (process.platform === 'win32') return true
  const name = basename(shell).toLowerCase()
  return name === 'nu' || name === 'nu.exe'
}

function currentShell(): string {
  return process.env.SHELL || '/bin/sh'
}

/** Parse `env -0` output. Empty result reads as a failed probe. */
function parseEnvZero(stdout: string | Buffer): Record<string, string> | null {
  const env: Record<string, string> = {}
  for (const line of stdout.toString().split('\0')) {
    if (!line) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    env[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return Object.keys(env).length > 0 ? env : null
}

/**
 * The cached login-shell env, or null when it has not been probed yet.
 * Schedules the warmup on a miss and returns immediately - never blocks.
 */
export function peekShellEnv(): Record<string, string> | null {
  if (cachedShellEnv !== undefined) return cachedShellEnv
  void warmShellEnv()
  return null
}

/**
 * Probe the login shell asynchronously, once per process. Concurrent callers
 * share the same child; a completed probe (including a failed one) is never
 * repeated - a shell that cannot answer will not answer on the next lookup
 * either, and retrying per lookup is how this became a hot-path cost.
 */
export function warmShellEnv(): Promise<Record<string, string> | null> {
  if (cachedShellEnv !== undefined) return Promise.resolve(cachedShellEnv)
  if (warmupInFlight) return warmupInFlight

  const shell = currentShell()
  if (unsupportedShell(shell)) {
    cachedShellEnv = null
    return Promise.resolve(null)
  }

  const probe = (flag: string): Promise<Record<string, string> | null> =>
    new Promise((resolve) => {
      execFile(shell, [flag, '-c', 'env -0'], {
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'buffer',
        maxBuffer: 4 * 1024 * 1024,
      }, (err, stdout) => {
        resolve(err ? null : parseEnvZero(stdout))
      })
    })

  warmupInFlight = (async () => {
    for (const flag of PROBE_FLAGS) {
      const env = await probe(flag)
      if (env) return env
    }
    return null
  })()
    .catch((err: unknown) => {
      log.warn(`login-shell environment probe failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    })
    .then((env) => {
      // First writer wins. The blocking `loadShellEnv()` shares this cache and
      // cannot join an in-flight probe, so a machine connect can answer while
      // this one is still running - and this one landing LATER with a failure
      // used to overwrite that good PATH with null for the rest of the
      // process, dropping every later provider lookup and ssh spawn back onto
      // Finder's truncated PATH.
      if (cachedShellEnv === undefined) {
        cachedShellEnv = env
        if (!env) log.warn('login-shell environment probe failed')
      }
      warmupInFlight = null
      return cachedShellEnv
    })

  return warmupInFlight
}

/**
 * Synchronous form. Blocks the event loop for up to `PROBE_TIMEOUT_MS` on a
 * cold cache, so it belongs only on paths that cannot continue without a
 * PATH and are already user-initiated one-shots (machine connect/provision).
 * Hot paths use `peekShellEnv()`.
 */
export function loadShellEnv(): Record<string, string> | null {
  if (cachedShellEnv !== undefined) return cachedShellEnv
  const shell = currentShell()
  if (unsupportedShell(shell)) {
    cachedShellEnv = null
    return null
  }
  const probe = (flag: string): Record<string, string> | null => {
    const out = spawnSync(shell, [flag, '-c', 'env -0'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    })
    if (out.error || out.status !== 0) return null
    return parseEnvZero(out.stdout)
  }
  cachedShellEnv = probe(PROBE_FLAGS[0]) ?? probe(PROBE_FLAGS[1])
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
  warmupInFlight = null
}
