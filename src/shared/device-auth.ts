/**
 * Per-device sessions for paired clients.
 *
 * Replaces one shared token that never expired, carried no scopes, could not be
 * revoked per device, and travelled in the URL query string. The QR now carries
 * a one-time pairing code, redeemed once for a session of the device's own, and
 * credentials travel in an `auth` frame.
 *
 * Be precise about what the scopes buy: a phone session cannot spawn a PTY or
 * administer pairings. It CAN do everything the chat surface does, and that
 * surface runs an agent. This is a reduction in blast radius, not a sandbox.
 */

/** `terminal` is separate because a PTY is arbitrary code execution and nothing
 *  on the phone needs it. */
export type DeviceScope = 'chat' | 'terminal' | 'admin'

export const PHONE_SCOPES: readonly DeviceScope[] = ['chat']
export const FULL_SCOPES: readonly DeviceScope[] = ['chat', 'terminal', 'admin']

/**
 * Channel prefixes a scope is REQUIRED for. Anything unlisted is open to any
 * authenticated session.
 *
 * Deliberately not deny-by-default: that needs a hand-maintained list of every
 * channel, and missing one breaks a feature silently for paired devices only.
 */
const SCOPE_REQUIRED_PREFIXES: Record<DeviceScope, readonly string[]> = {
  terminal: ['terminal:'],
  // Without this, a paired device could mint itself another session and revoke
  // every other device. Revocation must be out of reach of a revocable credential.
  admin: ['mobile-pairing:'],
  // `chat` gates nothing on its own. It is the baseline every session has.
  chat: [],
}

const SCOPE_REQUIRED_CHANNELS: Partial<Record<DeviceScope, readonly string[]>> = {
  terminal: ['app:save-launch-config'],
}

/**
 * Settings keys a chat-scoped device must not WRITE.
 *
 * `settings:set` is ungated for ordinary client preferences, but the table
 * also holds the mode a session starts in when the client did not
 * say (the phone routinely does not) and the OAuth client consent runs against.
 * Writable, those let a stolen phone credential grant itself full access.
 * Reads stay open: neither is a secret and the phone seeds its picker from one.
 */
const ADMIN_ONLY_SETTING_KEYS: readonly string[] = [
  'chat.defaultRuntimeMode',
  'google.clientId',
  'google.clientSecret',
]

/** Arg-level, because the channel is legitimately open. Enforced beside the
 *  channel check so no other route reaches the row. */
export function isSettingWriteAllowed(scopes: readonly DeviceScope[], key: unknown): boolean {
  if (typeof key !== 'string') return true // shape errors belong to the handler
  if (!ADMIN_ONLY_SETTING_KEYS.includes(key)) return true
  return scopes.includes('admin')
}

/** Whether a session holding `scopes` may call `channel`. */
export function isChannelAllowed(scopes: readonly DeviceScope[], channel: string): boolean {
  for (const [scope, prefixes] of Object.entries(SCOPE_REQUIRED_PREFIXES) as Array<
    [DeviceScope, readonly string[]]
  >) {
    if (prefixes.some((prefix) => channel.startsWith(prefix)) && !scopes.includes(scope)) return false
  }
  for (const [scope, channels] of Object.entries(SCOPE_REQUIRED_CHANNELS) as Array<
    [DeviceScope, readonly string[]]
  >) {
    if (channels.includes(channel) && !scopes.includes(scope)) return false
  }
  return true
}

function normalizedPath(path: string): string {
  const absolute = path.startsWith('/')
  const prefix = /^[A-Za-z]:[\\/]/.test(path) ? path.slice(0, 2).toLowerCase() : absolute ? '/' : ''
  const segments: string[] = []
  for (const segment of path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return `${prefix}${prefix && prefix !== '/' ? '/' : ''}${segments.join('/')}`.toLowerCase()
}

/** Protect command-bearing repository configuration from chat-only direct file APIs. */
export function isFileMutationAllowed(
  scopes: readonly DeviceScope[],
  repositoryPath: unknown,
  subPath: unknown,
): boolean {
  if (scopes.includes('terminal')) return true
  if (typeof repositoryPath !== 'string' || typeof subPath !== 'string') return true
  const root = normalizedPath(repositoryPath).replace(/\/$/, '')
  const candidate = subPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(subPath)
    ? normalizedPath(subPath)
    : normalizedPath(`${root}/${subPath}`)
  return candidate !== `${root}/.switchboard/launch-config.yaml`
    && candidate !== `${root}/.switchboard/workspace.yaml`
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
 *  treating it as a user-meaningful identifier. */
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

/** Short because the flow is "look at a screen, scan it now". A code valid for
 *  hours is a second long-lived credential, which is what this removes. */
export const PAIRING_CODE_TTL_MS = 5 * 60_000

export interface PairingCode {
  code: string
  expiresAt: number
  /** Consumed on first use, so a shoulder-surfed QR is worthless once the
   *  intended device has redeemed it. */
  usedAt?: number
}

export function isPairingCodeUsable(code: PairingCode | null, nowMs: number): boolean {
  return code !== null && code.usedAt === undefined && code.expiresAt > nowMs
}
