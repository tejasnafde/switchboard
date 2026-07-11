/**
 * When a conversation switches between Claude provider instances mid-flight
 * and the new instance has a different `CLAUDE_CONFIG_DIR` (oauth_dir), the
 * Claude SDK can't resume the session because the JSONL it reads from
 * `<dir>/projects/<encodedCwd>/<sessionId>.jsonl` lives in the *previous*
 * profile. This helper copies the file across so the SDK's UUID-based
 * resume path keeps working - preserving turn-by-turn conversation context
 * across credential rotation without re-paying input tokens.
 *
 * Pure I/O. Idempotent. Source is left untouched so rotating back later
 * still resolves cleanly.
 */
import { homedir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync, copyFileSync, readdirSync } from 'fs'
import { encodeClaudeProjectPath } from '../projects/session-scanner'
import { createMainLogger as createLogger } from '../logger'

const log = createLogger('provider:claude:migrate')

export function defaultClaudeDir(): string {
  return join(homedir(), '.claude')
}

export type MigrateResult =
  | { ok: true; copied: boolean; from?: string }
  | { ok: false; reason: 'source-missing' | 'io-error'; detail?: string }

/**
 * Locate `<sessionId>.jsonl` under `<dir>/projects/`. Tries the encoded cwd
 * first, then scans every project subdir: the Claude CLI re-roots a
 * transcript into the encoded dir of whatever cwd the session ends up in
 * (e.g. the agent entering a worktree mid-conversation), so the exact-path
 * lookup alone reported real sessions as missing. Session ids are UUIDs, so
 * a filename match anywhere under projects/ is unambiguous.
 */
export function findClaudeSessionFile(dir: string, sessionId: string, cwd: string): string | null {
  const file = `${sessionId}.jsonl`
  const exact = join(dir, 'projects', encodeClaudeProjectPath(cwd), file)
  if (existsSync(exact)) return exact
  const projects = join(dir, 'projects')
  if (!existsSync(projects)) return null
  for (const sub of readdirSync(projects)) {
    const candidate = join(projects, sub, file)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Does the session JSONL exist anywhere under `<dir>/projects/`?
 *
 * Exposed so callers can probe the destination dir before deciding whether
 * to bother running migration - the typical case (no rotation since
 * session creation) is a no-op skip.
 */
export function claudeSessionExistsIn(dir: string, sessionId: string, cwd: string): boolean {
  return findClaudeSessionFile(dir, sessionId, cwd) !== null
}

/**
 * Find the first dir from `candidates` that contains the session JSONL,
 * then copy it to `toDir`. Used when the in-memory rotation tracker
 * doesn't know the previous dir (app restart, fresh adapter instance) -
 * we scan known oauth_dirs + default to discover the source.
 *
 * Returns `source-missing` if no candidate has the file.
 */
export function migrateClaudeSessionFromCandidates(opts: {
  sessionId: string
  cwd: string
  toDir: string
  candidates: string[]
}): MigrateResult {
  for (const candidate of opts.candidates) {
    if (candidate === opts.toDir) continue
    if (claudeSessionExistsIn(candidate, opts.sessionId, opts.cwd)) {
      const r = migrateClaudeSession({
        sessionId: opts.sessionId,
        cwd: opts.cwd,
        fromDir: candidate,
        toDir: opts.toDir,
      })
      if (r.ok) return { ...r, from: candidate }
      // try next candidate on io-error
    }
  }
  return { ok: false, reason: 'source-missing' }
}

export interface MigrateOpts {
  sessionId: string
  cwd: string
  /** Resolved CLAUDE_CONFIG_DIR of the previous instance (or default). */
  fromDir: string
  /** Resolved CLAUDE_CONFIG_DIR of the new instance (or default). */
  toDir: string
}

/**
 * Copy `<fromDir>/projects/<encodedCwd>/<sessionId>.jsonl` to the same
 * relative path under `toDir`. No-op when fromDir === toDir.
 */
export function migrateClaudeSession(opts: MigrateOpts): MigrateResult {
  if (opts.fromDir === opts.toDir) {
    return { ok: true, copied: false }
  }

  const encoded = encodeClaudeProjectPath(opts.cwd)
  const file = `${opts.sessionId}.jsonl`
  // Destination stays the encoded startSession cwd - that is where the SDK's
  // resume looks. Source may live under a different encoded dir (worktree
  // re-rooting), hence the scan.
  const srcPath = findClaudeSessionFile(opts.fromDir, opts.sessionId, opts.cwd)
  const dstDir = join(opts.toDir, 'projects', encoded)
  const dstPath = join(dstDir, file)

  if (!srcPath) {
    log.warn(`source missing under ${join(opts.fromDir, 'projects')} for session ${opts.sessionId}`)
    return { ok: false, reason: 'source-missing' }
  }

  try {
    mkdirSync(dstDir, { recursive: true })
    copyFileSync(srcPath, dstPath)
    log.info(`migrated session ${opts.sessionId}: ${srcPath} → ${dstPath}`)
    return { ok: true, copied: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error(`copy failed: ${srcPath} → ${dstPath}: ${msg}`)
    return { ok: false, reason: 'io-error', detail: msg }
  }
}
