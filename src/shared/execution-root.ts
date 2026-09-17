/**
 * The execution root - where a conversation's provider actually runs.
 *
 * Switchboard has two different path concepts and they were being mixed:
 *
 *   - `projectPath` is the PARENT PROJECT IDENTITY. It never moves. It is the
 *     key the sidebar, the DB and the favicon cache group by.
 *   - the EXECUTION ROOT is the directory the provider process, the IDE, git,
 *     notebooks and new terminals actually use. It is the worktree when one is
 *     attached, and the project path otherwise.
 *
 * Before this module every call site wrote `worktreePath ?? projectPath` by
 * hand, and several of them wrote plain `projectPath`, which is why "Follow"
 * moved the branch chip but left new terminals in the old checkout. Route all
 * of it through `resolveExecutionRoot` instead.
 *
 * Two properties beyond the path itself matter:
 *
 *   - `machineId`. An absolute path is meaningful only on the backend that owns
 *     it. `/repo/app` on a remote VM is not `/repo/app` on this Mac, so a root
 *     comparison that ignores the machine will happily "match" two unrelated
 *     directories and send a local `cd` for a remote move.
 *   - `revision`. A relocation is asynchronous: drift evidence is gathered, a
 *     turn finishes, a provider restarts. Every one of those can land after the
 *     root already changed. The revision is the optimistic-concurrency token
 *     that lets a late result be recognised as stale and dropped instead of
 *     committing against a superseded root.
 *
 * This module is pure and platform-agnostic on purpose: it is imported by the
 * renderer, by both backend hosts, and by the mobile clients, and it must be
 * able to reason about a REMOTE machine's paths, which may use a different
 * separator style from the host it is running on. That is why it does not use
 * `node:path` - `path.sep` describes the wrong machine.
 */

/** Machine id for the in-process desktop backend. */
export const LOCAL_MACHINE_ID = 'local'

export interface ExecutionRoot {
  /** Parent project identity. Stable across relocations. */
  projectPath: string
  /** Directory the provider executes in. `worktreePath ?? projectPath`. */
  path: string
  /** Backend that owns `path`. An absolute path is meaningless without it. */
  machineId: string
  /** Resolved branch, or null when detached or not yet known. */
  branch: string | null
  /** Monotonic optimistic-concurrency token. 0 for a root that never moved. */
  revision: number
  /** True when `path` is a worktree rather than the parent checkout. */
  isWorktree: boolean
}

export interface ExecutionRootInput {
  projectPath: string
  worktreePath?: string | null
  worktreeBranch?: string | null
  machineId?: string | null
  executionRootRevision?: number | null
}

const WINDOWS_PREFIX = /^[A-Za-z]:[\\/]/
const TRAILING_SEPARATORS = /[\\/]+$/

function isWindowsStyle(path: string): boolean {
  return WINDOWS_PREFIX.test(path) || path.startsWith('\\\\')
}

/** True for `/` and for `C:\` - the one case where a trailing separator is part of the path. */
function isFilesystemRoot(path: string): boolean {
  return path === '/' || /^[A-Za-z]:[\\/]$/.test(path)
}

/**
 * Trim whitespace and trailing separators so two spellings of one directory
 * compare equal. Separator STYLE is left alone: it belongs to the owning
 * machine, and rewriting it would produce a path that machine cannot open.
 */
export function normalizeRootPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed || isFilesystemRoot(trimmed)) return trimmed
  const stripped = trimmed.replace(TRAILING_SEPARATORS, '')
  // A path that was nothing but separators collapses to the filesystem root.
  return stripped || trimmed.slice(0, 1)
}

/** Lowercased, forward-slashed form used only for comparison, never for I/O. */
function comparable(path: string, windows: boolean): string {
  const normalized = normalizeRootPath(path).replace(/\\/g, '/')
  return windows ? normalized.toLowerCase() : normalized
}

/**
 * Containment test that does not fall for a shared string prefix.
 *
 * `'/repo/app-old'.startsWith('/repo/app')` is true, and treating that as
 * containment would re-root a terminal sitting in an unrelated sibling
 * checkout. The separator is what makes it a boundary.
 */
export function isPathWithinRoot(root: string, candidate: string): boolean {
  const windows = isWindowsStyle(root) || isWindowsStyle(candidate)
  const canonicalRoot = comparable(root, windows)
  const canonicalCandidate = comparable(candidate, windows)
  if (!canonicalRoot || !canonicalCandidate) return false
  if (canonicalCandidate === canonicalRoot) return true
  const boundary = canonicalRoot.endsWith('/') ? canonicalRoot : `${canonicalRoot}/`
  return canonicalCandidate.startsWith(boundary)
}

export interface RebasedPath {
  /** The same logical location inside `toRoot`. */
  path: string
  /** Segment below the root, `''` when the path WAS the root. Empty means no subdirectory to preserve. */
  relative: string
}

/**
 * Map a path from one execution root to the equivalent place in another, so a
 * shell sitting in `<old>/packages/app` lands in `<new>/packages/app` instead
 * of being dumped at the top of the new tree.
 *
 * Returns null when `candidate` is not inside `fromRoot`. That is the guard
 * that keeps a pane deliberately rooted elsewhere from being moved at all.
 *
 * Whether the mapped directory EXISTS is a filesystem question, so it is the
 * caller's: check it, and fall back to `toRoot` if the subdirectory is absent.
 */
export function rebaseWithinRoot(
  fromRoot: string,
  toRoot: string,
  candidate: string,
): RebasedPath | null {
  if (!isPathWithinRoot(fromRoot, candidate)) return null
  const normalizedFrom = normalizeRootPath(fromRoot)
  const normalizedTo = normalizeRootPath(toRoot)
  const remainder = normalizeRootPath(candidate).slice(normalizedFrom.length)
  const relative = remainder.replace(/^[\\/]+/, '')
  if (!relative) return { path: normalizedTo, relative: '' }
  const separator = isWindowsStyle(normalizedTo) ? '\\' : '/'
  const rebasedTail = relative.replace(/[\\/]/g, separator)
  const joiner = normalizedTo.endsWith(separator) ? '' : separator
  return { path: `${normalizedTo}${joiner}${rebasedTail}`, relative }
}

/**
 * Build the canonical execution root for a conversation or session row.
 *
 * A blank worktree pointer is the same as no pointer: the DB column is
 * nullable, the wire protocol sends `null`, and some older rows carry an empty
 * string. All three must mean "use the project path".
 */
export function resolveExecutionRoot(input: ExecutionRootInput): ExecutionRoot {
  const projectPath = normalizeRootPath(input.projectPath)
  const worktreeRaw = input.worktreePath?.trim() ?? ''
  const worktreePath = worktreeRaw ? normalizeRootPath(worktreeRaw) : ''
  const machineId = input.machineId?.trim() || LOCAL_MACHINE_ID
  const isWorktree = Boolean(worktreePath) && !sameLocation(worktreePath, projectPath, machineId)
  const revision = Number.isSafeInteger(input.executionRootRevision) && (input.executionRootRevision as number) >= 0
    ? (input.executionRootRevision as number)
    : 0
  return {
    projectPath,
    path: isWorktree ? worktreePath : projectPath,
    machineId,
    branch: input.worktreeBranch?.trim() || null,
    revision,
    isWorktree,
  }
}

function sameLocation(a: string, b: string, machineId: string): boolean {
  const windows = isWindowsStyle(a) || isWindowsStyle(b)
  void machineId
  return comparable(a, windows) === comparable(b, windows)
}

/**
 * Identity comparison for two roots: same directory on the same backend.
 *
 * Branch and revision are deliberately excluded. A branch checkout inside one
 * directory is not a relocation, and a revision bump alone must not make the
 * app believe the provider has to restart.
 */
export function sameExecutionRoot(a: ExecutionRoot, b: ExecutionRoot): boolean {
  if (a.machineId !== b.machineId) return false
  return sameLocation(a.path, b.path, a.machineId)
}

function basename(path: string): string {
  const normalized = normalizeRootPath(path)
  const cut = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return cut >= 0 ? normalized.slice(cut + 1) : normalized
}

/** Short human label, for a status line or a toast. */
export function describeExecutionRoot(root: ExecutionRoot): string {
  const project = basename(root.projectPath)
  return root.isWorktree && root.branch ? `${project} · ${root.branch}` : project
}
