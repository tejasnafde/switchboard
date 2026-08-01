/**
 * Per-device sessions for paired clients.
 *
 * What this replaces: one shared token, stored forever, with no scopes and no
 * way to revoke a single device. Every phone that ever scanned the QR held the
 * same string, so "forget my old phone" meant rotating the token and re-pairing
 * every device including the ones you still wanted. The token also travelled in
 * the WebSocket URL query string, where it lands in proxy logs and process
 * listings.
 *
 * The model here is deliberately small, because the trust boundary is a machine
 * the user owns on a network they chose, not a hosted service:
 *
 *  - The QR carries a PAIRING code, which is one-time and short-lived. It buys
 *    exactly one thing: a device session.
 *  - A device session is per device, named, revocable on its own, and carries a
 *    scope set.
 *  - Everything travels in an `auth` frame after the socket opens, never in the
 *    URL.
 *
 * Scopes are not decoration. The phone app has no terminal UI at all, so a
 * phone session has no business being able to spawn a PTY on the paired
 * machine. Handing it one anyway is the difference between a stolen token
 * reading your conversations and it running commands as you.
 */

/**
 * What a session may do.
 *
 * `chat` is everything the phone actually uses. `terminal` is separate because
 * a PTY is arbitrary code execution and nothing on the phone needs it.
 * `full` exists for a desktop driving a remote backend, which genuinely does.
 */
export type DeviceScope = 'chat' | 'terminal'

export const PHONE_SCOPES: readonly DeviceScope[] = ['chat']
export const FULL_SCOPES: readonly DeviceScope[] = ['chat', 'terminal']

/**
 * Channel prefixes a scope is REQUIRED for. Anything not listed is open to any
 * authenticated session.
 *
 * Deny-by-default was the first instinct and it is wrong here. It needs a
 * hand-maintained list of every channel the app uses, and the failure mode of
 * missing one is a feature that silently stops working for paired devices,
 * discovered by a user rather than a test. Denying the small set that is
 * genuinely dangerous is both safer to maintain and honest about what the
 * boundary is actually for: keeping arbitrary code execution away from a
 * credential that only needs to read and reply to conversations.
 */
const SCOPE_REQUIRED_PREFIXES: Record<DeviceScope, readonly string[]> = {
  terminal: ['terminal:'],
  // `chat` gates nothing on its own. It is the baseline every session has.
  chat: [],
}

/** Whether a session holding `scopes` may call `channel`. */
export function isChannelAllowed(scopes: readonly DeviceScope[], channel: string): boolean {
  for (const [scope, prefixes] of Object.entries(SCOPE_REQUIRED_PREFIXES) as Array<
    [DeviceScope, readonly string[]]
  >) {
    if (prefixes.some((prefix) => channel.startsWith(prefix)) && !scopes.includes(scope)) return false
  }
  return true
}

export interface DeviceSession {
  /** Stable id for this device's session; what a revoke targets. */
  id: string
  /** sha256 of the session token. The token itself is never stored. */
  tokenHash: string
  /** Free text so a user with two phones can tell them apart. */
  label: string
  scopes: DeviceScope[]
  createdAt: number
  lastSeenAt: number
  revokedAt?: number
}

export function isRevoked(session: DeviceSession): boolean {
  return session.revokedAt !== undefined
}

/** What the UI may see. The hash is not a secret, but showing it invites
 *  someone to treat it as an identifier that means something to a user. */
export interface DeviceSessionView {
  id: string
  label: string
  scopes: DeviceScope[]
  createdAt: number
  lastSeenAt: number
  revoked: boolean
}

export function toView(session: DeviceSession): DeviceSessionView {
  return {
    id: session.id,
    label: session.label,
    scopes: session.scopes,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    revoked: isRevoked(session),
  }
}

/**
 * How long a pairing code is good for.
 *
 * Short because the whole flow is "look at a screen, scan it now". A code left
 * valid for hours is a second long-lived credential, which is the thing this
 * design exists to remove.
 */
export const PAIRING_CODE_TTL_MS = 5 * 60_000

export interface PairingCode {
  code: string
  expiresAt: number
  /** Consumed on first use: a QR photographed over someone's shoulder is only
   *  worth anything until the intended device redeems it. */
  usedAt?: number
}

export function isPairingCodeUsable(code: PairingCode | null, nowMs: number): boolean {
  return code !== null && code.usedAt === undefined && code.expiresAt > nowMs
}
