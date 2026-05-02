/**
 * Pre-flight readability check for session working directories.
 *
 * macOS TCC ("Files and Folders" / "Full Disk Access") gates app access to
 * ~/Desktop, ~/Documents, ~/Downloads, and a few other locations. When a
 * grant is missing — or, more commonly, when the user toggled it on but
 * never relaunched Switchboard — every FS syscall the embedded PTY/SDK
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
 * Throws TccAccessError if `cwd` is a TCC-protected location that the
 * current process can't read. Resolves silently otherwise (including
 * non-darwin, non-protected paths, and paths that don't exist — those
 * surface as their own errors downstream).
 */
export async function assertCwdReadable(cwd: string): Promise<void> {
  if (!isTccProtectedPath(cwd)) return
  try {
    await access(cwd, constants.R_OK)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'EPERM' || code === 'EACCES') {
      throw new TccAccessError(cwd)
    }
    // ENOENT and friends fall through — adapter will report them.
  }
}
