/**
 * PID-file ownership for the headless backend.
 *
 * The remote bootstrap (machines/connectDeps.ts REMOTE_COMMAND) reads
 * `~/.switchboard-server/server.pid` and kills that pid before launching a
 * fresh server, so the file is the ONLY handle anything has on a lingering
 * process. That makes two properties load-bearing:
 *
 *  - It must name the process that actually holds the port. Writing it at module
 *    load - before the bind can fail - let a relaunch that immediately
 *    EADDRINUSE'd overwrite the pid of the real owner, after which the
 *    bootstrap's kill aimed at a corpse and the true holder ran unbounded (a
 *    server survived 41h at 99% CPU that way).
 *  - Removing it must be conditional on still owning it, so a takeover's pid is
 *    never clobbered by the outgoing process's shutdown.
 *
 * The io seam keeps both rules unit-testable without touching a real fs.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface PidFileIo {
  ensureDir(dir: string): void
  /** File contents, or null when it does not exist / cannot be read. */
  read(path: string): string | null
  write(path: string, contents: string): void
  remove(path: string): void
}

export const nodePidFileIo: PidFileIo = {
  ensureDir: (dir) => { mkdirSync(dir, { recursive: true }) },
  read: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  write: (path, contents) => { writeFileSync(path, contents) },
  remove: (path) => { unlinkSync(path) },
}

/**
 * Exit code for a failed bind. Distinct and nonzero so ssh reports it back
 * through the tunnel instead of the old behaviour - logging the error and
 * staying alive forever with no listener.
 */
export const BIND_FAILURE_EXIT_CODE = 3

export type PidClaim = 'claimed' | 'failed'
export type PidRelease = 'released' | 'not-owner' | 'absent'

/** The pid recorded in the file, or null if absent/unparseable. */
export function pidFileOwner(io: PidFileIo, file: string): number | null {
  const raw = io.read(file)
  if (raw === null) return null
  const pid = Number(raw.trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/**
 * Take ownership of the pidfile. Unconditional by design: whoever is listening
 * IS the owner, and the predecessor recorded here is by definition no longer
 * holding the port (we just bound it). Call this only after `listening`.
 */
export function claimPidFile(io: PidFileIo, file: string, pid: number): PidClaim {
  try {
    io.ensureDir(dirname(file))
    io.write(file, String(pid))
    return 'claimed'
  } catch {
    return 'failed'
  }
}

/** Remove the pidfile only while it still points at us. */
export function releasePidFile(io: PidFileIo, file: string, pid: number): PidRelease {
  const owner = pidFileOwner(io, file)
  if (owner === null) return 'absent'
  if (owner !== pid) return 'not-owner'
  try {
    io.remove(file)
    return 'released'
  } catch {
    return 'absent'
  }
}

/** True for the errno a second server binding an already-held port gets. */
export function isAddressInUse(err: unknown): boolean {
  return Boolean(err) && (err as { code?: string }).code === 'EADDRINUSE'
}
