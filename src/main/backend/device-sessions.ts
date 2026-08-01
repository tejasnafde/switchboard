/**
 * Device sessions, stored in the settings table alongside the rest of the
 * backend's state.
 *
 * Tokens are stored as sha256 hashes, never in the clear. That is not
 * theatre: the settings table is a plain SQLite file, readable by anything
 * running as the user, and the whole point of a per-device credential is that
 * compromising the record should not hand over the credential.
 *
 * A pairing code is separate, single-use, and short-lived. It is the only
 * thing the QR carries.
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
import { getSetting, setSetting } from '../db/database'
import { createMainLogger } from '../logger'

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
    return Array.isArray(parsed) ? (parsed as DeviceSession[]).filter((s) => typeof s?.tokenHash === 'string') : []
  } catch {
    // A corrupt row must not lock the user out of their own machine, and it
    // cannot be repaired here. Treat it as no sessions; re-pairing recovers.
    log.warn('device session store is unreadable, treating as empty')
    return []
  }
}

function saveSessions(sessions: DeviceSession[]): void {
  setSetting(SESSIONS_KEY, JSON.stringify(sessions))
}

export function listSessionViews(): DeviceSessionView[] {
  return listSessions().map(toView)
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
 * Exchange a pairing code for a device session.
 *
 * The code is consumed whether or not the caller keeps the result, so a QR
 * photographed over a shoulder is worth nothing once the intended device has
 * used it.
 */
export function redeemPairingCode(
  presented: string,
  label: string,
  scopes: DeviceScope[],
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
  const session: DeviceSession = {
    id: randomUUID(),
    tokenHash: hashToken(token),
    label: label.trim() || 'device',
    scopes,
    createdAt: nowMs,
    lastSeenAt: nowMs,
  }
  saveSessions([...listSessions(), session])
  log.info(`paired a new device (${session.label}) with scopes ${scopes.join(',')}`)
  return { ok: true, session: token, scopes }
}

/** Resolve a presented session token, or null when it is unknown or revoked. */
export function authenticateSession(token: string, nowMs: number = Date.now()): DeviceSession | null {
  const presented = hashToken(token)
  const sessions = listSessions()
  const found = sessions.find((s) => hashMatches(s.tokenHash, presented))
  if (!found || isRevoked(found)) return null
  // Cheap enough to keep honest: the list is small and a device connects
  // rarely. `lastSeenAt` is what makes the revoke UI usable.
  saveSessions(sessions.map((s) => (s.id === found.id ? { ...s, lastSeenAt: nowMs } : s)))
  return { ...found, lastSeenAt: nowMs }
}

/**
 * Revoke one device. Tombstoned rather than deleted so the list still shows
 * what was removed and when, which is the point of having it.
 */
export function revokeSession(id: string, nowMs: number = Date.now()): boolean {
  const sessions = listSessions()
  const target = sessions.find((s) => s.id === id)
  if (!target || isRevoked(target)) return false
  saveSessions(sessions.map((s) => (s.id === id ? { ...s, revokedAt: nowMs } : s)))
  log.info(`revoked device session ${target.label}`)
  return true
}
