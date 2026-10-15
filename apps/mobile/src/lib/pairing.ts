/**
 * Parsing the pairing payload. Lives in lib/ because the connections store
 * imports react-native, which the root vitest suite cannot load.
 */

import { CERT_PIN_PARAM, isCertFingerprint } from '@shared/transport-security'

/**
 * Parse a pairing payload, from the QR or typed by hand.
 *
 *   ws://host:8765?pair=<code>    one-time code, redeemed for a device session
 *   ws://host:8765?token=<tok>    legacy shared secret, still accepted
 *   ...&fp=<sha256 hex>           the backend's TLS certificate, kept in the
 *                                 saved URL for a pinned wss:// dial. This app
 *                                 cannot pin yet (React Native's WebSocket has
 *                                 no hook for it), so it still dials the scheme
 *                                 it was given. A malformed `fp` is refused.
 *
 * `pair` wins when both are present: a desktop offering a code supports
 * sessions, and taking the shared token there opts back into the credential the
 * code exists to replace.
 */
export function parsePairingUrl(raw: string): { url: string; token?: string; pairing?: string } | null {
  const trimmed = raw.trim()
  if (!/^wss?:\/\//.test(trimmed)) return null
  try {
    const u = new URL(trimmed)
    const pairing = u.searchParams.get('pair') ?? undefined
    const token = pairing ? undefined : (u.searchParams.get('token') ?? undefined)
    const fingerprint = u.searchParams.get(CERT_PIN_PARAM)?.toLowerCase()
    if (fingerprint !== undefined && !isCertFingerprint(fingerprint)) return null
    u.search = ''
    const url = u.toString().replace(/\/$/, '')
    return { url: fingerprint ? `${url}?${CERT_PIN_PARAM}=${fingerprint}` : url, token, pairing }
  } catch {
    // Validator, not an error path: malformed input is the expected case and the
    // caller shows the message. Logging here would fire on every keystroke.
    return null
  }
}
