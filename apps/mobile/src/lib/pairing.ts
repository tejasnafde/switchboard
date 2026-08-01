/**
 * Parsing the pairing payload.
 *
 * Lives in lib/ rather than the connections store because that store imports
 * react-native and expo-network, which the root vitest suite cannot load. The
 * rule in CLAUDE.md exists for exactly this: decisions belong somewhere they
 * can be tested without a device.
 */

/**
 * Parse a pairing payload, from the QR or typed by hand.
 *
 *   ws://host:8765?pair=<code>   current: a one-time code, redeemed for a
 *                                session of this device's own
 *   ws://host:8765?token=<tok>   legacy: the shared secret, still accepted so
 *                                an older desktop can still be paired with
 *
 * `pair` wins when both are present: a desktop offering a code is one that
 * supports sessions, and taking the shared token there would opt back into the
 * credential the code exists to replace.
 */
export function parsePairingUrl(raw: string): { url: string; token?: string; pairing?: string } | null {
  const trimmed = raw.trim()
  if (!/^wss?:\/\//.test(trimmed)) return null
  try {
    const u = new URL(trimmed)
    const pairing = u.searchParams.get('pair') ?? undefined
    const token = pairing ? undefined : (u.searchParams.get('token') ?? undefined)
    u.search = ''
    return { url: u.toString().replace(/\/$/, ''), token, pairing }
  } catch {
    // Validator, not an error path: malformed input is the expected case and the
    // caller shows the message. Logging here would fire on every keystroke.
    return null
  }
}
