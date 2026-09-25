/**
 * The one rule for "is this provider instance signed in", shared by the
 * Settings Test probe and the usage reader.
 *
 * An expired ACCESS token is not a logged-out account: the CLI refreshes it on
 * its next API call, and Switchboard deliberately never refreshes it itself
 * (racing the CLI's rotation can log the user out). Only a missing credential,
 * a missing refresh token, or the CLI's own "not logged in" means logged out.
 */

export type ProviderAuthState =
  | 'signed-in'
  /** Signed in, but the stored access token expired; the next CLI call refreshes it. */
  | 'refresh-pending'
  | 'logged-out'

/** Treat a token inside this window as already expired. */
export const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60_000

export interface ProviderAuthEvidence {
  /** The CLI's own verdict (`claude auth status` loggedIn). Omitted when it was not asked. */
  cliLoggedIn?: boolean
  /** The stored credential when it was read, null when none exists. Omitted when it was not read. */
  credential?: { expiresAtMs: number | null; hasRefreshToken: boolean } | null
  nowMs: number
}

export function providerAuthState(evidence: ProviderAuthEvidence): ProviderAuthState {
  if (evidence.cliLoggedIn === false) return 'logged-out'
  const credential = evidence.credential
  if (credential === null) return 'logged-out'
  if (credential === undefined) return evidence.cliLoggedIn ? 'signed-in' : 'logged-out'
  const { expiresAtMs, hasRefreshToken } = credential
  if (expiresAtMs === null || expiresAtMs - ACCESS_TOKEN_EXPIRY_SKEW_MS > evidence.nowMs) return 'signed-in'
  return hasRefreshToken ? 'refresh-pending' : 'logged-out'
}
