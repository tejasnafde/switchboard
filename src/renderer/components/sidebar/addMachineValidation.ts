/**
 * Pure validation/dedupe helpers for the Add-machine modal, split out so
 * they're unit-testable without mounting the component (see sshHostFilter.ts
 * for the same pattern applied to the host search box).
 */
import type { Machine } from '@shared/machines'

/** True when `candidate` matches an already-added remote by ssh alias, or by
 *  user@host when neither side has an alias. Prevents the same host from
 *  being added twice via two different flows (ssh-config pick vs. manual). */
export function isDuplicateMachine(
  remotes: Machine[],
  candidate: { sshAlias?: string | null; sshHost: string; sshUser?: string | null },
): boolean {
  const alias = candidate.sshAlias?.trim().toLowerCase()
  const host = candidate.sshHost.trim().toLowerCase()
  const user = candidate.sshUser?.trim().toLowerCase() ?? ''
  return remotes.some((m) => {
    if (alias && m.sshAlias && m.sshAlias.trim().toLowerCase() === alias) return true
    return m.sshHost.trim().toLowerCase() === host && (m.sshUser?.trim().toLowerCase() ?? '') === user
  })
}

const MIN_PORT = 1
const MAX_PORT = 65535

/**
 * Parse a port string typed into the manual-add form. Returns null for
 * anything that isn't a bare integer in the valid TCP port range - the
 * caller should block submission rather than silently coercing garbage
 * input to a default port.
 */
export function parsePort(input: string): number | null {
  const trimmed = input.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const n = Number(trimmed)
  if (n < MIN_PORT || n > MAX_PORT) return null
  return n
}

