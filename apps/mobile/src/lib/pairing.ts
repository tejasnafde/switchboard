/**
 * Parsing the pairing payload. Lives in lib/ because the connections store
 * imports react-native, which the root vitest suite cannot load.
 */

/**
 * Parse a pairing payload, from the QR or typed by hand.
 *
 *   ws://host:8765?pair=<code>    one-time code, redeemed for a device session
 *   ws://host:8765?token=<tok>    legacy shared secret, still accepted
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
    u.search = ''
    return { url: u.toString().replace(/\/$/, ''), token, pairing }
  } catch {
    // Validator, not an error path: malformed input is the expected case and the
    // caller shows the message. Logging here would fire on every keystroke.
    return null
  }
}
