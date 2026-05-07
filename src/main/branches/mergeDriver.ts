/**
 * mergiraf detection + per-repo merge-driver setup.
 *
 * mergiraf (https://mergiraf.org) is an AST-aware structural merge
 * tool. Wired as a custom git merge driver, it replaces git's textual
 * 3-way merge for files it understands (TypeScript, Python, Java, etc.)
 * and falls back to plain markers for the rest.
 *
 * Two pieces:
 *   1. `installMergirafDriver` writes the driver config to `.git/config`
 *      (`merge.mergiraf.name` + `merge.mergiraf.driver`). One-time per
 *      repo; idempotent (`git config` overwrites the key).
 *   2. `ensureGitattributesEntry` appends `* merge=mergiraf` to the
 *      repo's `.gitattributes` so git actually invokes the driver.
 *      Idempotent — never duplicates, never overwrites user lines.
 */

import { join } from 'node:path'
import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitRunner } from '../worktree'

const execFileP = promisify(execFile)

/** mergiraf's documented merge-driver invocation. Exposed as a
 *  constant so tests can assert on the exact string + future tweaks
 *  land in one place. */
const MERGIRAF_DRIVER_CMD =
  'mergiraf merge --git %O %A %B -s %S -x %X -y %Y -p %P'
const MERGIRAF_DRIVER_NAME = 'mergiraf AST-aware merge'

export interface MergirafProbe {
  found: boolean
  path?: string
  version?: string
}

export interface DetectMergirafDeps {
  /** Returns the resolved binary path. Throws if not in PATH. */
  which: (cmd: string) => Promise<string>
  /** Same shape as the worktree GitRunner — re-used here for
   *  `mergiraf --version` because it uses execFile and accepts an
   *  argv list. `args[0]` is the binary (not `'git'`). */
  runner: GitRunner
}

const defaultWhich = async (cmd: string): Promise<string> => {
  const tool = process.platform === 'win32' ? 'where' : 'which'
  const { stdout } = await execFileP(tool, [cmd], { timeout: 5_000 })
  const first = stdout.split('\n')[0]?.trim()
  if (!first) throw new Error(`${cmd} not found`)
  return first
}

const defaultRunnerForVersion: GitRunner = async (args, cwd) => {
  const [bin, ...rest] = args
  const res = await execFileP(bin, rest, { cwd, timeout: 5_000 })
  return { stdout: res.stdout, stderr: res.stderr }
}

/**
 * Detect mergiraf on PATH. Returns `{ found: false }` if `which`
 * fails; if the binary is found but `--version` flakes, returns
 * `{ found: true, path }` without a version (still usable).
 *
 * Cached for the main process lifetime when invoked with default
 * deps. Tests inject custom deps and bypass the cache. The cache is
 * busted by `installMergirafDriver` (which only runs after the user
 * just installed mergiraf).
 */
let cachedProbe: MergirafProbe | null = null
export async function detectMergiraf(
  deps: Partial<DetectMergirafDeps> = {},
): Promise<MergirafProbe> {
  const usingDefaults = !deps.which && !deps.runner
  if (usingDefaults && cachedProbe) return cachedProbe
  const which = deps.which ?? defaultWhich
  const runner = deps.runner ?? defaultRunnerForVersion
  let probe: MergirafProbe
  let path: string
  try {
    path = await which('mergiraf')
  } catch {
    probe = { found: false }
    if (usingDefaults) cachedProbe = probe
    return probe
  }
  try {
    const { stdout } = await runner(['mergiraf', '--version'], process.cwd())
    probe = { found: true, path, version: stdout.trim() || undefined }
  } catch {
    probe = { found: true, path }
  }
  if (usingDefaults) cachedProbe = probe
  return probe
}

/** Drop the cached mergiraf probe — call after a successful install
 *  so subsequent `detectMergiraf()` re-probes. */
export function resetMergirafCache(): void {
  cachedProbe = null
}

/**
 * One-time per-repo setup. Writes the driver config to .git/config via
 * `git config`. The driver invocation matches mergiraf's documented
 * recipe — it falls back to git's textual merge for unsupported
 * languages, so this is safe to enable repo-wide.
 */
export async function installMergirafDriver(
  repoPath: string,
  runner: GitRunner,
): Promise<void> {
  await runner(['config', 'merge.mergiraf.name', MERGIRAF_DRIVER_NAME], repoPath)
  await runner(['config', 'merge.mergiraf.driver', MERGIRAF_DRIVER_CMD], repoPath)
}

export interface FsDeps {
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, content: string) => Promise<void>
}

const GITATTRIBUTES_LINE = '* merge=mergiraf'

/**
 * Append `* merge=mergiraf` to the repo's `.gitattributes` if it isn't
 * already there. Creates the file if missing. Never reorders user
 * lines.
 *
 * `fsDeps` is injectable so tests don't touch the real filesystem.
 */
export async function ensureGitattributesEntry(
  repoPath: string,
  fsDeps: Partial<FsDeps> = {},
): Promise<void> {
  const readFile = fsDeps.readFile ?? ((p: string) => fsReadFile(p, 'utf-8'))
  const writeFile = fsDeps.writeFile ?? ((p: string, c: string) => fsWriteFile(p, c, 'utf-8'))
  const target = join(repoPath, '.gitattributes')
  let existing = ''
  try {
    existing = await readFile(target)
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code !== 'ENOENT') throw err
  }
  // Match the exact line (anywhere — start of file, after newline, etc.)
  // including a trailing newline tolerance.
  const linePattern = /(^|\n)\* merge=mergiraf(\r?\n|$)/
  if (linePattern.test(existing)) return // already present
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
  await writeFile(target, `${existing}${sep}${GITATTRIBUTES_LINE}\n`)
}
