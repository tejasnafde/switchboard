/**
 * Pre-flight readability check for session working directories.
 *
 * macOS TCC ("Files and Folders" / "Full Disk Access") gates app access to
 * ~/Desktop, ~/Documents, ~/Downloads, and a few other locations. When a
 * grant is missing - or, more commonly, when the user toggled it on but
 * never relaunched Switchboard - every FS syscall the embedded PTY/SDK
 * makes returns EPERM. Surfacing the raw error from deep in the adapter
 * stack reads as a Claude/Codex bug; instead we detect it here and throw
 * a message that names the actual cause and the fix.
 */
import { access, constants } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { resolve, sep } from 'node:path'

const TCC_SUBDIRS = ['Desktop', 'Documents', 'Downloads']

export function isTccProtectedPath(p: string, home: string = homedir()): boolean {
  if (platform() !== 'darwin') return false
  const abs = resolve(p)
  return TCC_SUBDIRS.some((sub) => {
    const root = resolve(home, sub)
    return abs === root || abs.startsWith(root + sep)
  })
}

export class MissingCwdError extends Error {
  readonly code = 'SWITCHBOARD_CWD_MISSING'
  constructor(public readonly path: string) {
    super(
      `The project folder "${path}" no longer exists. If it was a worktree it may ` +
        `have been removed or cleaned up. Reopen the project from an existing path ` +
        `or recreate the worktree.`,
    )
    this.name = 'MissingCwdError'
  }
}

export class TccAccessError extends Error {
  readonly code = 'SWITCHBOARD_TCC_DENIED'
  constructor(public readonly path: string) {
    super(
      `macOS is blocking Switchboard from reading "${path}". ` +
        `Open System Settings → Privacy & Security → Files and Folders → Switchboard, ` +
        `enable the relevant folder (Desktop / Documents / Downloads), then fully quit ` +
        `Switchboard with ⌘Q and reopen it. (TCC grants only apply to processes started ` +
        `after the grant.)`,
    )
    this.name = 'TccAccessError'
  }
}

/**
 * Throws MissingCwdError if `cwd` does not exist (node's spawn reports a
 * missing cwd as ENOENT on the *command*, so downstream the SDK blames the
 * claude binary instead of the folder). Throws TccAccessError if `cwd` is a
 * TCC-protected location that the current process can't read. Resolves
 * silently otherwise - other failure codes surface as their own errors
 * downstream.
 */
export async function assertCwdReadable(cwd: string): Promise<void> {
  try {
    await access(cwd, constants.R_OK)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') {
      throw new MissingCwdError(cwd)
    }
    if ((code === 'EPERM' || code === 'EACCES') && isTccProtectedPath(cwd)) {
      throw new TccAccessError(cwd)
    }
  }
}
