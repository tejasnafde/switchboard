/**
 * Open a project on another machine: the target clones the repository from
 * the remote the source's current branch tracks, then the desktop copies the
 * ignored files the user picked, reading each from the source backend and
 * writing it to the target backend. The two backends never talk to each other.
 *
 * Channels (`ProjectCloneChannels`) need the `terminal` scope: a clone runs
 * git with a caller's URL, and the ignored-file reads and writes carry
 * secrets. The target needs `PROJECT_CLONE_CAPABILITY`; an older one is
 * refused before anything starts.
 */

export const PROJECT_CLONE_CAPABILITY = 'project_clone_v1'

/** Ignored files larger than this are not offered. */
export const IGNORED_FILE_MAX_BYTES = 1024 * 1024
/** At most this many ignored files are offered. */
export const IGNORED_FILE_MAX_COUNT = 200

/** Folders that hold installs or build output, never offered at any depth. */
const EXCLUDED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.gradle',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.switchboard',
])

export interface CloneSource {
  /** The remote name on the source, for display. */
  remoteName: string
  url: string
  /** The source's checked out branch, or null on a detached HEAD. */
  branch: string | null
  /** The branch name on the remote to check out, or null for the remote's default. */
  remoteBranch: string | null
  /** Ignored files that pass every rule, as paths relative to the project. */
  ignored: Array<{ path: string; size: number }>
  /** Ignored entries left out: folders, links, binary or large files, past the count cap. */
  skippedIgnored: number
}

export type CloneSourceResult =
  | ({ ok: true } & CloneSource)
  | { ok: false; reason: 'no-remote' | 'error'; error: string }

export interface CloneRequest {
  url: string
  remoteBranch: string | null
  /** Folder name under the target's projects folder. */
  name: string
}

export type CloneStartResult = { ok: true; path: string } | { ok: false; error: string }

export type CloneStatus =
  | { phase: 'cloning'; line: string }
  | { phase: 'done'; branch: string | null }
  | { phase: 'failed'; error: string }
  | { phase: 'unknown' }

export type IgnoredReadResult = { ok: true; content: string } | { ok: false; error: string }

export const NO_REMOTE_MESSAGE =
  'This project has no git remote, so the other machine has nothing to clone from. Add a remote and push, then try again.'

export const SUBFOLDER_MESSAGE =
  'This project is a folder inside a git repository. Add the repository root as a project and open that on the other machine.'

export const LOCAL_REMOTE_MESSAGE =
  "This project's remote is a path on this computer, so the other machine cannot reach it. Use a remote with a network URL."

/** A URL another machine can reach: `scheme://`, or the scp form `host:path`. A bare or `file://` path is local. */
export function isNetworkCloneUrl(url: string): boolean {
  if (/^file:/i.test(url)) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return true
  // scp form: a colon before any slash, and not a Windows drive letter.
  return /^[^/\\]+:/.test(url) && !/^[a-z]:[\\/]/i.test(url)
}

export interface RemoteConfig {
  branch: string | null
  /** `branch.<name>.remote`: the remote the current branch tracks. */
  trackedRemote: string | null
  /** `branch.<name>.merge`, e.g. `refs/heads/feat`. */
  trackedMerge: string | null
  remotes: string[]
}

/**
 * The remote to clone from. The current branch's tracked remote comes first,
 * so a branch on a fork clones the fork, not the repository it was forked
 * from. Without one: `origin`, then the first remote. Null when there is none.
 */
export function chooseCloneRemote(config: RemoteConfig): { remote: string; remoteBranch: string | null } | null {
  const { trackedRemote, trackedMerge, remotes } = config
  if (trackedRemote && trackedRemote !== '.' && remotes.includes(trackedRemote)) {
    const merged = trackedMerge?.startsWith('refs/heads/') ? trackedMerge.slice('refs/heads/'.length) : null
    return { remote: trackedRemote, remoteBranch: merged }
  }
  const remote = remotes.includes('origin') ? 'origin' : remotes[0]
  if (!remote) return null
  // An untracked branch may not exist on the remote; the target falls back to the default branch.
  return { remote, remoteBranch: config.branch }
}

/**
 * Which `git ls-files --others --ignored --exclude-standard --directory -z`
 * entries may be offered at all. Folders (a trailing slash) and anything
 * under an install or build folder are dropped before any stat.
 */
export function offerableIgnoredPath(entry: string): boolean {
  if (!entry || entry.endsWith('/')) return false
  return !entry.split('/').some((segment) => EXCLUDED_SEGMENTS.has(segment))
}

/** Text means valid UTF-8 with no NUL byte. */
export function isTextContent(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/** A folder name for the clone: the source folder name, cut to safe characters. */
export function cloneFolderName(projectPath: string): string {
  const base =
    projectPath
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? ''
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '')
  return safe || 'project'
}

export function isValidCloneFolderName(name: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(name)
}

/**
 * Only URLs git fetches over a network or from a path. `ext::` and `fd::`
 * run commands, and a leading `-` would read as an option.
 */
export function isSafeCloneUrl(url: string): boolean {
  if (!url || url.startsWith('-') || /[\x00-\x1f\x7f]/.test(url)) return false
  if (/^[a-z][a-z0-9+.-]*::/i.test(url)) return false
  return true
}

/** The last progress line from git's `--progress` stderr (it rewrites lines with \r). */
export function lastProgressLine(stderr: string): string {
  const lines = stderr.split(/[\r\n]+/).filter((line) => line.trim())
  return lines.length > 0 ? lines[lines.length - 1].trim() : ''
}

/** Why the project cannot be cloned elsewhere, or null when it can. */
export function cloneSourceProblem(result: CloneSourceResult): string | null {
  if (!result.ok) return result.reason === 'no-remote' ? NO_REMOTE_MESSAGE : result.error
  return isNetworkCloneUrl(result.url) ? null : LOCAL_REMOTE_MESSAGE
}
