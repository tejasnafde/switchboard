/**
 * Device sessions, in the settings table with the rest of the backend's state.
 *
 * Tokens are stored as sha256 hashes: the settings table is a plain SQLite
 * file, and the point of a per-device credential is that compromising the
 * record should not hand over the credential.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  isPairingCodeUsable,
  isRevoked,
  toView,
  PAIRING_CODE_TTL_MS,
  type DeviceScope,
  type DeviceSession,
  type DeviceSessionView,
  type PairingCode,
} from '@shared/device-auth'
import { parseDeviceIdentity, type DeviceIdentity } from '@shared/device-identity'
import { getSetting, setSetting } from '../db/database'
import { createMainLogger } from '../logger'
import { unregisterSessionDevices } from '../push/registry'

const log = createMainLogger('backend:device-sessions')

const SESSIONS_KEY = 'deviceSessions'
const PAIRING_KEY = 'devicePairingCode'

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Constant-time compare of two hex digests of equal length. */
function hashMatches(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

export function listSessions(): DeviceSession[] {
  const raw = getSetting(SESSIONS_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return (parsed as DeviceSession[]).filter((s) => typeof s?.tokenHash === 'string').map(withValidIdentity)
  } catch {
    // A corrupt row must not lock the user out of their own machine.
    log.warn('device session store is unreadable, treating as empty')
    return []
  }
}

/** Rows written before device_identity_v1 carry no identity and stay valid;
 *  one that does not parse is dropped rather than shown half-formed. */
function withValidIdentity(session: DeviceSession): DeviceSession {
  if (session.identity === undefined) return session
  const identity = parseDeviceIdentity(session.identity)
  if (identity) return { ...session, identity }
  const { identity: _dropped, ...rest } = session
  return rest
}

function saveSessions(sessions: DeviceSession[]): void {
  setSetting(SESSIONS_KEY, JSON.stringify(sessions))
}

/** Revoked devices are left out: a row that stays after Revoke reads as if
 *  Revoke did nothing. `online` holds the session ids with an open,
 *  authenticated socket; it lives in the endpoint's memory, not the store. */
export function listSessionViews(online: ReadonlySet<string> = new Set()): DeviceSessionView[] {
  return listSessions()
    .filter((s) => !isRevoked(s))
    .map((s) => toView(s, online.has(s.id)))
}

/** What a connection says about the device behind it, recorded on auth. */
export interface DeviceConnectContext {
  device?: DeviceIdentity
  address?: string
}

/** IPv4 peers on a dual-stack listener arrive as `::ffff:a.b.c.d`. */
export function normalizeAddress(address: string | undefined): string | undefined {
  if (!address) return undefined
  return address.startsWith('::ffff:') && address.includes('.') ? address.slice('::ffff:'.length) : address
}

function withContext(session: DeviceSession, context: DeviceConnectContext): DeviceSession {
  const address = normalizeAddress(context.address)
  return {
    ...session,
    ...(context.device ? { identity: context.device } : {}),
    ...(address ? { lastAddress: address } : {}),
  }
}

/** Mint a pairing code for the QR. Replaces any previous unused one. */
export function createPairingCode(nowMs: number = Date.now()): PairingCode {
  const code: PairingCode = {
    code: randomBytes(9).toString('base64url'),
    expiresAt: nowMs + PAIRING_CODE_TTL_MS,
  }
  setSetting(PAIRING_KEY, JSON.stringify(code))
  return code
}

export function readPairingCode(): PairingCode | null {
  const raw = getSetting(PAIRING_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as PairingCode
  } catch {
    return null
  }
}

export interface RedeemResult {
  ok: boolean
  session?: string
  scopes?: DeviceScope[]
  error?: string
}

/**
 * The code is consumed whether or not the caller keeps the result.
 *
 * A pairing that names an installId an unrevoked session already holds is the
 * same install pairing again (a reinstall, or a re-scan after a lost
 * credential). The old session is revoked through `revokeSession`, so its
 * socket closes and its push tokens go, instead of a duplicate row being left
 * behind. Only a pairing does this: it already needs the one-time QR code, so
 * a known installId alone cannot revoke anything.
 */
export function redeemPairingCode(
  presented: string,
  label: string,
  scopes: DeviceScope[],
  context: DeviceConnectContext = {},
  nowMs: number = Date.now(),
): RedeemResult {
  const stored = readPairingCode()
  if (!isPairingCodeUsable(stored, nowMs) || !stored) {
    return { ok: false, error: 'pairing code expired or already used' }
  }
  if (!hashMatches(hashToken(stored.code), hashToken(presented))) {
    return { ok: false, error: 'pairing code not recognised' }
  }
  setSetting(PAIRING_KEY, JSON.stringify({ ...stored, usedAt: nowMs }))

  const token = randomBytes(24).toString('base64url')
  const session = withContext(
    {
      id: randomUUID(),
      tokenHash: hashToken(token),
      label: label.trim() || 'device',
      scopes,
      createdAt: nowMs,
      lastSeenAt: nowMs,
    },
    context,
  )
  const existing = listSessions()
  saveSessions([...existing, session])
  log.info(`paired a new device (${session.label}) with scopes ${scopes.join(',')}`)
  const installId = session.identity?.installId
  if (installId) {
    for (const old of existing) {
      if (old.identity?.installId !== installId || isRevoked(old)) continue
      log.info('a re-paired install replaces its earlier device session')
      // Best effort: the new pairing has already succeeded, and the phone
      // holds a one-time code it cannot use again. A failed cleanup of the old
      // session must not take the minted token away from it.
      try {
        revokeSession(old.id, nowMs)
      } catch (err) {
        log.warn('could not finish revoking the superseded device session', err)
      }
    }
  }
  return { ok: true, session: token, scopes }
}

/**
 * Resolve a presented session token, or null when it is unknown or revoked.
 * Records what the connection says about the device: a phone's name, OS and
 * app version change under a session that outlives them.
 */
export function authenticateSession(
  token: string,
  context: DeviceConnectContext = {},
  nowMs: number = Date.now(),
): DeviceSession | null {
  const presented = hashToken(token)
  const sessions = listSessions()
  const found = sessions.find((s) => hashMatches(s.tokenHash, presented))
  if (!found || isRevoked(found)) return null
  // The list is small and a device connects rarely; lastSeenAt makes the
  // revoke UI usable.
  const updated = withContext({ ...found, lastSeenAt: nowMs }, context)
  saveSessions(sessions.map((s) => (s.id === found.id ? updated : s)))
  return updated
}

/** Refresh lastSeenAt for a session that is still connected. A revoked or
 *  vanished session is left alone: its sockets are closing anyway. */
export function touchSession(id: string, nowMs: number = Date.now()): boolean {
  const sessions = listSessions()
  const target = sessions.find((s) => s.id === id)
  if (!target || isRevoked(target)) return false
  saveSessions(sessions.map((s) => (s.id === id ? { ...s, lastSeenAt: nowMs } : s)))
  return true
}

/**
 * Notified when a session is revoked, so live sockets for it can be closed.
 * Set by whoever owns the listener; a tombstone alone is not revocation.
 */
let onRevoked: ((id: string) => void) | null = null
export function setRevocationListener(fn: ((id: string) => void) | null): void {
  onRevoked = fn
}

/** Tombstoned: the store keeps when a device was revoked, the list hides it. */
export function revokeSession(id: string, nowMs: number = Date.now()): boolean {
  const sessions = listSessions()
  const target = sessions.find((s) => s.id === id)
  if (!target || isRevoked(target)) return false
  saveSessions(sessions.map((s) => (s.id === id ? { ...s, revokedAt: nowMs } : s)))
  log.info(`revoked device session ${target.label}`)
  try {
    unregisterSessionDevices(id)
  } finally {
    onRevoked?.(id)
  }
  return true
}
