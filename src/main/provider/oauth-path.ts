/**
 * Canonicalization and home-confinement for user-typed OAuth profile dirs.
 *
 * The oauth_dir field is free text a user types into Settings → Providers,
 * and it ends up in two places that both need it to be an unambiguous
 * absolute path: the `CLAUDE_CONFIG_DIR` / `CODEX_HOME` of a spawned CLI, and
 * the uniqueness key that keeps two profiles from sharing one credential
 * store. `~/.codex-work`, `/tmp/x/../x`, and `/tmp/x/` are the same directory
 * but three different strings, so every consumer canonicalizes through here
 * rather than comparing what the user happened to type.
 *
 * Lives outside `db/` because both the DB layer and the adapters need it and
 * the adapters must not import the DB.
 */

import { realpathSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, normalize, resolve, sep } from 'path'

/**
 * Expand a leading `~`, then collapse `..`, `.` and duplicate/trailing
 * separators. Returns null/'' unchanged so callers can keep treating an unset
 * oauth_dir as "no per-instance dir".
 *
 * Only the *lexical* form is canonicalized - no filesystem access, because
 * this runs on rows for dirs that may not exist yet (a profile created before
 * its first `codex login`).
 */
export function canonicalizeOauthPath(p: string | null | undefined): string | null {
  if (p === null || p === undefined) return p ?? null
  const trimmed = p.trim()
  if (!trimmed) return ''
  const expanded = trimmed === '~'
    ? homedir()
    : trimmed.startsWith(`~${sep}`) || trimmed.startsWith('~/')
      ? join(homedir(), trimmed.slice(2))
      : trimmed
  return stripTrailingSep(normalize(expanded))
}

/** Drop trailing separators so `/tmp/x/` and `/tmp/x` compare equal. Root
 *  (`/`, `C:\`) keeps its separator - it is the whole path. */
function stripTrailingSep(p: string): string {
  let out = p
  while (out.length > 1 && out.endsWith(sep) && !isRootPath(out)) out = out.slice(0, -1)
  return out
}

function isRootPath(p: string): boolean {
  return resolve(p) === resolve(p, '..')
}

/** True when `child` is `parent` itself or nested under it. Lexical - callers
 *  that care about symlinks resolve their paths first. */
export function isWithinDir(parent: string, child: string): boolean {
  if (child === parent) return true
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

export type OauthDirResolution =
  | { ok: true; path: string }
  | { ok: false; error: string }

/**
 * Validate a user-typed path for the Settings "Create" button.
 *
 * A credential directory is only ever created inside the user's own home:
 * the button exists to make `~/.codex-work`, not to let a mistyped (or
 * renderer-injected) path mkdir into `/etc` or, via an existing symlink hop,
 * into a directory the user never chose. `..` is collapsed before the check
 * so `~/x/../../etc/evil` cannot walk out, and every existing ancestor is
 * resolved through `realpathSync` so a symlink cannot either.
 *
 * Pure apart from those read-only realpath calls - the caller does the mkdir.
 */
export function resolveOauthDirForCreate(input: string, home: string = homedir()): OauthDirResolution {
  const raw = (input ?? '').trim()
  if (!raw) return { ok: false, error: 'OAuth directory path is required.' }

  const canonical = canonicalizeOauthPath(raw)
  if (!canonical) return { ok: false, error: 'OAuth directory path is required.' }
  // A relative path would resolve against whatever cwd the child happens to
  // have; anchor it to the home dir the button is scoped to instead.
  const target = stripTrailingSep(normalize(isAbsolute(canonical) ? canonical : join(home, canonical)))
  const homeDir = stripTrailingSep(normalize(home))

  if (target === homeDir || !isWithinDir(homeDir, target)) {
    return { ok: false, error: 'OAuth directory must be a new folder inside your home directory.' }
  }

  const realHome = realPathOrNull(homeDir)
  const ancestor = nearestExistingRealPath(target)
  if (realHome && ancestor && !isWithinDir(realHome, ancestor)) {
    return { ok: false, error: 'OAuth directory resolves outside your home directory.' }
  }

  return { ok: true, path: target }
}

function realPathOrNull(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

/**
 * Real path of the deepest ancestor of `p` (including `p`) that exists.
 * Null when nothing on the chain resolves - e.g. a home dir that is not on
 * this filesystem at all, where there is no symlink to escape through and the
 * lexical check above is the whole answer.
 */
function nearestExistingRealPath(p: string): string | null {
  let current = p
  for (;;) {
    const real = realPathOrNull(current)
    if (real) return real
    const parent = resolve(current, '..')
    if (parent === current) return null
    current = parent
  }
}
