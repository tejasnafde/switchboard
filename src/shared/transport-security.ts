/**
 * Encrypted transport rules shared by the desktop QR and the phones.
 *
 * The backend serves wss:// with a self-signed certificate on the same port as
 * ws://. The pairing URL carries the certificate's SHA-256 as `fp`; a phone
 * that can pin dials wss:// and refuses any other certificate. A phone that
 * cannot ignores `fp` and keeps ws://.
 */

/** Query parameter holding the pinned certificate fingerprint. */
export const CERT_PIN_PARAM = 'fp'

/** SHA-256 of the certificate's DER as 64 lowercase hex characters. */
export function isCertFingerprint(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}

/** Hosts where plain ws:// never leaves the device (or the emulator's host). */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || h === '10.0.2.2' || /^127\.\d+\.\d+\.\d+$/.test(h)
}

/**
 * Why a build that requires encryption must not dial `url`, or null when it may.
 * Only plain ws:// to a host off this device is refused.
 */
export function cleartextRefusal(url: string): string | null {
  const match = /^ws:\/\/(\[[^\]]*\]|[^/:?#]*)/i.exec(url.trim())
  if (!match || isLoopbackHost(match[1])) return null
  return 'This build needs an encrypted connection. Use a wss:// address or Cloud IAP.'
}

/** The pairing URL with the certificate pin appended, when there is one. */
export function withCertPin(url: string, fingerprint: string | null | undefined): string {
  if (!fingerprint) return url
  return `${url}${url.includes('?') ? '&' : '?'}${CERT_PIN_PARAM}=${fingerprint}`
}
