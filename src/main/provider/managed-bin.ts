/**
 * Switchboard's managed CLI bin directory, and deterministic precedence for it.
 *
 * Provisioning links the `claude` and `codex` it installed into
 * `$HOME/.local/bin` (see machines/provisionSetup.ts). Two things then went
 * wrong on remotes:
 *
 *  - The runtime PATH omitted that directory entirely. The tunnel launches the
 *    backend from a non-interactive ssh shell, whose PATH has no ~/.local/bin,
 *    so a `which`-style lookup could not see the tools we had just installed.
 *  - Where a directory earlier in the candidate list happened to contain a
 *    same-named binary, the adapters latched onto that shadow instead - a
 *    different (or broken) build, chosen silently.
 *
 * So: the managed dir goes FIRST, is deduped out of the inherited PATH so a
 * user profile cannot demote it, and candidate resolution prefers it while
 * still refusing an entry that is not actually executable.
 *
 * `SWITCHBOARD_MANAGED_BIN` is exported by the remote bootstrap so the server
 * uses the dir provisioning really wrote to rather than re-deriving it.
 */
import { realpathSync, statSync } from 'node:fs'

export const MANAGED_BIN_ENV = 'SWITCHBOARD_MANAGED_BIN'

/** The managed bin dir, or null when there is no HOME to derive one from. */
export function managedBinDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env[MANAGED_BIN_ENV]?.trim()
  if (explicit) return explicit
  const home = env.HOME?.trim()
  return home ? `${home}/.local/bin` : null
}

/**
 * PATH with the managed bin dir first, then `extraDirs`, then the inherited
 * PATH - each directory appearing exactly once at its highest precedence.
 */
export function managedPath(env: NodeJS.ProcessEnv = process.env, extraDirs: string[] = []): string {
  const inherited = (env.PATH || '/usr/bin:/bin').split(':').filter(Boolean)
  const managed = managedBinDir(env)
  const ordered = [...(managed ? [managed] : []), ...extraDirs, ...inherited]
  const seen = new Set<string>()
  return ordered.filter((dir) => (seen.has(dir) ? false : (seen.add(dir), true))).join(':')
}

export interface ManagedExecutable {
  path: string
  source: 'managed' | 'fallback'
}

/**
 * Resolve `name` preferring the managed dir, then each fallback dir in order.
 * An entry that is not executable is skipped rather than returned, so a
 * dangling managed symlink degrades to the next real candidate instead of
 * becoming a spawn ENOENT.
 */
export function preferManagedExecutable(
  name: string,
  opts: {
    env?: NodeJS.ProcessEnv
    fallbackDirs?: string[]
    isExecutable: (path: string) => boolean
  },
): ManagedExecutable | null {
  const env = opts.env ?? process.env
  const managed = managedBinDir(env)
  if (managed) {
    const candidate = `${managed}/${name}`
    if (opts.isExecutable(candidate)) return { path: candidate, source: 'managed' }
  }
  for (const dir of opts.fallbackDirs ?? []) {
    const candidate = `${dir}/${name}`
    if (opts.isExecutable(candidate)) return { path: candidate, source: 'fallback' }
  }
  return null
}

/**
 * A cheap fingerprint of what `path` currently resolves to: the real target
 * plus its size and mtime. Changes when provisioning repoints a managed
 * symlink or npm replaces the target in place, which is what lets a
 * long-running server notice a repaired/upgraded CLI. Null when the path does
 * not resolve at all (including a dangling symlink), so a broken managed link
 * reads as absent rather than as an unchanged hit.
 */
export function executableIdentity(path: string): string | null {
  try {
    const real = realpathSync(path)
    const st = statSync(real)
    return `${real}:${st.size}:${st.mtimeMs}`
  } catch {
    return null
  }
}

export interface ExecutableResolution {
  path: string
  identity: string
}

export interface ExecutableCache {
  /** Last resolution, without re-checking the filesystem. */
  current(): ExecutableResolution | null
  /**
   * Re-resolve when nothing is cached, when the cached path no longer resolves,
   * or when its identity changed. A MISS IS NEVER CACHED FOREVER: the remote
   * backend outlives provisioning, so a tool installed after boot has to
   * become visible without restarting the process. It IS remembered for a
   * bounded, short window (see NEGATIVE_CACHE_TTL_MS) so a hot caller
   * (isAvailable(), listModels()) does not re-run a subprocess/filesystem
   * probe on every single invocation while the tool is genuinely absent.
   */
  refresh(): ExecutableResolution | null
}

/**
 * How long a miss is remembered before the next `refresh()` re-probes. Short
 * enough that a tool provisioning just installed becomes visible well within
 * one user-visible retry; long enough that a caller polling in a tight loop
 * does not re-run `which`/execSync/fs stats on every call.
 */
const NEGATIVE_CACHE_TTL_MS = 3_000

export function createExecutableCache(deps: {
  resolve: () => string | null
  identify: (path: string) => string | null
  /** Injectable for tests; defaults to the real clock. */
  now?: () => number
}): ExecutableCache {
  const now = deps.now ?? Date.now
  let cached: ExecutableResolution | null = null
  let missAt: number | null = null

  const resolveFresh = (): ExecutableResolution | null => {
    const path = deps.resolve()
    if (!path) {
      cached = null
      missAt = now()
      return null
    }
    missAt = null
    cached = { path, identity: deps.identify(path) ?? '' }
    return cached
  }

  return {
    current: () => cached,
    refresh() {
      if (!cached) {
        if (missAt !== null && now() - missAt < NEGATIVE_CACHE_TTL_MS) return null
        return resolveFresh()
      }
      const identity = deps.identify(cached.path)
      if (identity === null) return resolveFresh()
      if (identity !== cached.identity) return resolveFresh()
      return cached
    },
  }
}
