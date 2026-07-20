/**
 * Git checkpoint primitives for the in-chat diff-review feature.
 *
 * The agent providers (Claude / Codex / OpenCode) each surface file edits in
 * a different, partially-opaque shape. Rather than normalise three wire
 * formats, we treat *git* as the source of truth: snapshot the working tree
 * at the start of a turn, snapshot it again at the end, and diff the two.
 * This is provider-agnostic and deterministic - it sees exactly the bytes
 * that hit disk, no matter who wrote them.
 *
 * A snapshot is taken into a throwaway temp index (`GIT_INDEX_FILE`) so we
 * never disturb the user's real index, staging area, or HEAD:
 *
 *   GIT_INDEX_FILE=<tmp> git add -A      # stage every change incl. untracked
 *   GIT_INDEX_FILE=<tmp> git write-tree  # → a tree object sha
 *
 * The resulting tree sha is a loose object in the repo's object DB (not
 * GC'd within a turn) and is enough to diff against; we never create a
 * commit or move a ref. Diffing start-tree vs end-tree (`--no-renames` so a
 * rename reads as delete+add) yields the per-file change set, and
 * `git show <tree>:<path>` recovers each side's content.
 *
 * Pure-ish module: every fn accepts an optional `runner` so tests inject a
 * fake exec. Default runner shells out to `git`.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMainLogger } from '../logger'

const log = createMainLogger('git:checkpoint')
const execFileP = promisify(execFile)

export type ChangeKind = 'add' | 'modify' | 'delete'

export interface CheckpointFileDiff {
  relPath: string
  changeKind: ChangeKind
  /** Content at the start checkpoint. Empty string for an added file. */
  oldContent: string
  /** Content at the end checkpoint. Empty string for a deleted file. */
  newContent: string
}

/**
 * Test seam. Default runs `git` via execFile. Tests pass a stub that matches
 * argv arrays to canned responses. `env` is merged over the process env so
 * we can scope `GIT_INDEX_FILE` to a single command.
 */
export type CheckpointGitRunner = (
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
) => Promise<{ stdout: string; stderr: string }>

/**
 * Inherited GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE (set by git when running
 * hooks) would redirect our git calls at a DIFFERENT repo than `cwd` - this
 * once wiped a parent repo's index when the suite ran under pre-commit.
 */
export function scrubGitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { GIT_DIR: _d, GIT_INDEX_FILE: _i, GIT_WORK_TREE: _w, ...clean } = base
  return clean
}

const defaultRunner: CheckpointGitRunner = async (args, cwd, env) => {
  const res = await execFileP('git', args, {
    cwd,
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...scrubGitEnv(process.env), ...env },
  })
  return { stdout: res.stdout, stderr: res.stderr }
}

let tmpIndexCounter = 0

function freshTempIndexPath(): string {
  tmpIndexCounter += 1
  return join(tmpdir(), `sb-ckpt-index-${process.pid}-${Date.now()}-${tmpIndexCounter}`)
}

/** Whether `repoRoot` is inside a git work tree. */
export async function isGitRepo(repoRoot: string, runner: CheckpointGitRunner = defaultRunner): Promise<boolean> {
  try {
    const { stdout } = await runner(['rev-parse', '--is-inside-work-tree'], repoRoot)
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

/**
 * Snapshot the current working tree into a tree object, returning its sha.
 * Does not touch the user's real index/HEAD.
 */
export async function createCheckpoint(
  repoRoot: string,
  runner: CheckpointGitRunner = defaultRunner,
): Promise<{ ok: true; tree: string } | { ok: false; error: string }> {
  const tree = await writeWorkingTree(repoRoot, runner)
  if (tree == null) return { ok: false, error: 'failed to write working-tree snapshot' }
  return { ok: true, tree }
}

/**
 * Diff a start checkpoint (tree sha) against the *current* working tree,
 * returning the per-file change set with both sides' content.
 */
export async function diffCheckpoint(
  repoRoot: string,
  startTree: string,
  runner: CheckpointGitRunner = defaultRunner,
): Promise<{ ok: true; files: CheckpointFileDiff[] } | { ok: false; error: string }> {
  const endTree = await writeWorkingTree(repoRoot, runner)
  if (endTree == null) return { ok: false, error: 'failed to write end-checkpoint snapshot' }

  // Identical trees diff to nothing - skip the spawn (common on turns that
  // wrote no files).
  if (endTree === startTree) return { ok: true, files: [] }

  let nameStatus: string
  try {
    const { stdout } = await runner(
      ['diff', '-z', '--name-status', '--no-renames', startTree, endTree],
      repoRoot,
    )
    nameStatus = stdout
  } catch (err) {
    log.warn('checkpoint diff failed', { repoRoot, err })
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const entries = parseNameStatusZ(nameStatus)
  const files: CheckpointFileDiff[] = []
  // Fetch both sides of each file with bounded concurrency instead of the
  // old fully-serial 2N `git show` chain. Order of `files` is preserved.
  // ponytail: still 2 spawns per changed file; `git cat-file --batch` (one
  // long-lived process) is the upgrade path if many-file turns get slow.
  const CONTENT_CONCURRENCY = 8
  for (let i = 0; i < entries.length; i += CONTENT_CONCURRENCY) {
    const batch = entries.slice(i, i + CONTENT_CONCURRENCY)
    const resolved = await Promise.all(
      batch.map(async ({ changeKind, relPath }) => {
        const [oldContent, newContent] = await Promise.all([
          changeKind === 'add' ? '' : showContent(repoRoot, startTree, relPath, runner),
          changeKind === 'delete' ? '' : showContent(repoRoot, endTree, relPath, runner),
        ])
        return { relPath, changeKind, oldContent, newContent }
      }),
    )
    files.push(...resolved)
  }
  return { ok: true, files }
}

/**
 * Stage all working-tree changes into a temp index and write a tree object.
 *
 * Fast path: when the working tree is clean relative to HEAD, HEAD's tree
 * IS the snapshot - `rev-parse HEAD^{tree}` replaces the `add -A` pass,
 * which rehashes every file in the repo into a fresh temp index and was the
 * dominant per-turn cost. Read-only / chat-only turns on a clean tree now
 * cost two cheap stat-walks instead of two full rehashes.
 */
async function writeWorkingTree(repoRoot: string, runner: CheckpointGitRunner): Promise<string | null> {
  try {
    // --ignore-submodules=none: a submodule.<name>.ignore=all config would
    // otherwise hide a moved gitlink and wrongly take the fast path.
    const { stdout: status } = await runner(['status', '--porcelain', '--ignore-submodules=none'], repoRoot)
    if (status.trim() === '') {
      const { stdout } = await runner(['rev-parse', 'HEAD^{tree}'], repoRoot)
      const tree = stdout.trim()
      if (tree) return tree
    }
  } catch (err) {
    // Expected for a fresh repo without HEAD; the full snapshot below is
    // the fallback either way.
    log.debug('clean-tree fast path unavailable', { repoRoot, err: err instanceof Error ? err.message : String(err) })
  }

  const indexPath = freshTempIndexPath()
  const env = { GIT_INDEX_FILE: indexPath }
  try {
    await runner(['add', '-A'], repoRoot, env)
    const { stdout } = await runner(['write-tree'], repoRoot, env)
    const tree = stdout.trim()
    return tree || null
  } catch (err) {
    log.warn('write-tree snapshot failed', { repoRoot, err })
    return null
  } finally {
    await rm(indexPath, { force: true }).catch((err) =>
      log.warn('failed to remove temp index', { indexPath, err }),
    )
  }
}

/** `git show <tree>:<path>` → content, or '' if the path is absent. */
async function showContent(
  repoRoot: string,
  tree: string,
  relPath: string,
  runner: CheckpointGitRunner,
): Promise<string> {
  try {
    const { stdout } = await runner(['show', `${tree}:${relPath}`], repoRoot)
    return stdout
  } catch (err) {
    log.warn('git show failed for checkpoint file', { tree, relPath, err })
    return ''
  }
}

const STATUS_TO_KIND: Record<string, ChangeKind> = { A: 'add', M: 'modify', D: 'delete' }

/** Parse `git diff -z --name-status` output: STATUS\0path\0STATUS\0path\0… */
function parseNameStatusZ(out: string): Array<{ changeKind: ChangeKind; relPath: string }> {
  const tokens = out.split('\0').filter((t) => t.length > 0)
  const entries: Array<{ changeKind: ChangeKind; relPath: string }> = []
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const status = tokens[i][0]
    const relPath = tokens[i + 1]
    const changeKind = STATUS_TO_KIND[status]
    if (changeKind) entries.push({ changeKind, relPath })
  }
  return entries
}
