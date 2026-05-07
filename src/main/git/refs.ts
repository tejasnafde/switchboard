/**
 * Per-thread branch picker primitives. Three jobs:
 *
 *   - listRefs(cwd): enumerate every local + remote-tracking branch and
 *     annotate each with whether it already has an associated worktree
 *     (so the picker can reuse vs. checkout). Mirrors the t3code
 *     api.vcs.listRefs shape.
 *   - switchRef(cwd, refName): `git checkout <ref>` after validating the
 *     ref name so we never pass `-rf` or `..` to git.
 *   - getCurrentBranch(cwd): used by the trigger chip to render `main ▾`.
 *
 * Pure parsers (parseForEachRef, parseWorktreeBranchMap) and the
 * isValidRefName guard are exported separately for unit testing — same
 * pattern as src/main/worktree.ts.
 *
 * Cross-platform: every path comes back from git CLI as the OS-native
 * separator already; we don't normalize, since callers compare against
 * git's own output too.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createMainLogger } from '../logger'

const log = createMainLogger('git-refs')
const execFileP = promisify(execFile)

export interface Ref {
  /** Short name — `main`, `feat/foo`, `origin/feature` (no `refs/heads/` prefix). */
  name: string
  /** SHA the ref points at (short or long, whatever git emitted). */
  sha: string
  /** Is HEAD currently checked out to this ref? Only true for one local ref. */
  current: boolean
  /** Tracking ref from a remote (`refs/remotes/...`)? */
  isRemote: boolean
  /**
   * Absolute path to the worktree this branch is checked out in, if any.
   * `null` for branches with no associated worktree (most cases) and for
   * remote refs.
   */
  worktreePath: string | null
}

/** Test seam — same shape as the worktree.ts GitRunner. */
export type GitRunner = (
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string }>

const defaultRunner: GitRunner = async (args, cwd) => {
  const res = await execFileP('git', args, { cwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })
  return { stdout: res.stdout, stderr: res.stderr }
}

/**
 * Parse `git worktree list --porcelain` into a `branchName -> worktreePath`
 * map. Detached worktrees are skipped (no branch to key on). Branch names
 * are returned with the `refs/heads/` prefix already stripped so we can
 * look them up with the same key parseForEachRef uses.
 */
export function parseWorktreeBranchMap(porcelain: string): Map<string, string> {
  const out = new Map<string, string>()
  let curPath: string | null = null
  let curBranch: string | null = null
  const flush = () => {
    if (curPath && curBranch) out.set(curBranch, curPath)
    curPath = null
    curBranch = null
  }
  for (const line of porcelain.split('\n')) {
    if (line === '') {
      flush()
      continue
    }
    const sp = line.indexOf(' ')
    const key = sp === -1 ? line : line.slice(0, sp)
    const val = sp === -1 ? '' : line.slice(sp + 1)
    if (key === 'worktree') curPath = val
    else if (key === 'branch') curBranch = val.replace(/^refs\/heads\//, '')
    // 'detached' / 'HEAD' / 'prunable' lines: nothing to record here
  }
  flush()
  return out
}

/**
 * Parse `git for-each-ref --format='%(refname)\x00%(objectname)\x00%(HEAD)'`
 * into Ref[]. Branches under `refs/heads/` become local refs; anything
 * under `refs/remotes/` becomes a remote ref with the remote name kept
 * in the displayed `name` (so `origin/main` survives as-is).
 */
export function parseForEachRef(stdout: string, worktreeMap: Map<string, string>): Ref[] {
  const out: Ref[] = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const parts = line.split('\x00')
    if (parts.length < 3) continue
    const [refname, sha, headMarker] = parts
    let name: string
    let isRemote: boolean
    if (refname.startsWith('refs/heads/')) {
      name = refname.slice('refs/heads/'.length)
      isRemote = false
    } else if (refname.startsWith('refs/remotes/')) {
      name = refname.slice('refs/remotes/'.length)
      isRemote = true
    } else {
      continue // tags / stash / other namespaces — out of scope
    }
    out.push({
      name,
      sha,
      current: headMarker === '*',
      isRemote,
      worktreePath: isRemote ? null : worktreeMap.get(name) ?? null,
    })
  }
  return out
}

/**
 * Defense-in-depth ref-name guard. Mirrors the *forbidden* parts of
 * `git check-ref-format`:
 *   - reject `-` prefix (would be parsed as a flag by `git checkout`)
 *   - reject `..` anywhere (path traversal in ref names is a known
 *     family of CVEs)
 *   - reject control chars + whitespace
 *   - reject empty + overlong (>= 256 chars is well past sanity)
 *   - reject `.lock` suffix and trailing `/`
 *
 * Not a full check-ref-format port — git itself will reject the
 * remaining edge cases. This guard is just enough to make sure we
 * never call `execFile('git', ['checkout', userInput])` with something
 * that could be mistaken for a CLI flag.
 */
export function isValidRefName(name: string): boolean {
  if (!name) return false
  if (name.length > 255) return false
  if (name.startsWith('-')) return false
  if (name.endsWith('/') || name.endsWith('.lock')) return false
  if (name.includes('..')) return false
  if (/[\x00-\x1f\x7f\s~^:?*[\\]/.test(name)) return false
  return true
}

export async function listRefs(cwd: string, runner: GitRunner = defaultRunner): Promise<Ref[]> {
  // Worktree map first — small + needed to annotate refs with their
  // associated worktree paths. Errors here aren't fatal; the picker just
  // loses the reuse hint.
  let worktreeMap = new Map<string, string>()
  try {
    const { stdout } = await runner(['worktree', 'list', '--porcelain'], cwd)
    worktreeMap = parseWorktreeBranchMap(stdout)
  } catch (err) {
    log.warn(`worktree list failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // NUL-delimited so branch names containing `=` or `|` survive intact.
  const { stdout } = await runner(
    [
      'for-each-ref',
      '--format=%(refname)\x00%(objectname)\x00%(HEAD)',
      'refs/heads',
      'refs/remotes',
    ],
    cwd,
  )
  return parseForEachRef(stdout, worktreeMap)
}

export async function switchRef(
  cwd: string,
  refName: string,
  runner: GitRunner = defaultRunner,
): Promise<void> {
  if (!isValidRefName(refName)) {
    throw new Error(`invalid ref name: ${JSON.stringify(refName)}`)
  }
  await runner(['checkout', refName], cwd)
}

export async function getCurrentBranch(
  cwd: string,
  runner: GitRunner = defaultRunner,
): Promise<string | null> {
  const { stdout } = await runner(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  const branch = stdout.trim()
  // Detached HEAD prints the literal string 'HEAD' — surface that as null
  // so the trigger chip can fall back to "(detached)".
  if (!branch || branch === 'HEAD') return null
  return branch
}
