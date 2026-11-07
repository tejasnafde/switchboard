/**
 * The git facts the bridge's evidence is built from: the checkout's HEAD,
 * branch, working-tree snapshot, dirty state and the number of files that
 * differ from a recorded baseline tree.
 *
 * Snapshots reuse `git/checkpoint.ts` (`createCheckpoint`), the same
 * throwaway-index path the diff cards use, so nothing here touches the
 * user's index, staging area or HEAD. Every call is read-only.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createCheckpoint, scrubGitEnv, type CheckpointGitRunner } from '../git/checkpoint'
import { createMainLogger } from '../logger'

const log = createMainLogger('bridge:git-facts')
const execFileP = promisify(execFile)

export interface BridgeGitFacts {
  /** The commit HEAD points at, or null in a repository with no commit yet. */
  head: string | null
  /** The branch name, or null on a detached HEAD. */
  branch: string | null
  /** The working tree as a git tree id. */
  tree: string
  dirty: boolean
}

export const bridgeGitRunner: CheckpointGitRunner = async (args, cwd, env) => {
  const res = await execFileP('git', args, {
    cwd,
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...scrubGitEnv(process.env), ...env },
  })
  return { stdout: res.stdout, stderr: res.stderr }
}

async function text(args: string[], cwd: string, runner: CheckpointGitRunner): Promise<string | null> {
  try {
    const { stdout } = await runner(args, cwd)
    return stdout.trim()
  } catch (err) {
    log.debug('git read failed', { command: args[0], err: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/** Reads the checkout. Null when `cwd` is not a readable git work tree. */
export async function readBridgeGitFacts(
  cwd: string,
  runner: CheckpointGitRunner = bridgeGitRunner,
): Promise<BridgeGitFacts | null> {
  const inside = await text(['rev-parse', '--is-inside-work-tree'], cwd, runner)
  if (inside !== 'true') return null
  const status = await text(['status', '--porcelain', '--ignore-submodules=none'], cwd, runner)
  if (status === null) return null
  const snapshot = await createCheckpoint(cwd, runner)
  if (!snapshot.ok) {
    log.warn('could not snapshot the checkout for bridge evidence', { error: snapshot.error })
    return null
  }
  const head = await text(['rev-parse', 'HEAD'], cwd, runner)
  const branch = await text(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, runner)
  return {
    head: head || null,
    branch: branch && branch !== 'HEAD' ? branch : null,
    tree: snapshot.tree,
    dirty: status !== '',
  }
}

/** Files that differ between two trees, or null when the diff cannot be read. */
export async function countChangedFiles(
  cwd: string,
  fromTree: string,
  toTree: string,
  runner: CheckpointGitRunner = bridgeGitRunner,
): Promise<number | null> {
  if (fromTree === toTree) return 0
  const out = await text(['diff', '-z', '--name-only', '--no-renames', fromTree, toTree], cwd, runner)
  if (out === null) return null
  return out.split('\0').filter((p) => p.length > 0).length
}
