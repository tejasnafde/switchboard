/**
 * How a saved machine's transport reads on the phones' machine lists, and the
 * copy both phones show for it. Expo imports this file; native Android keeps a
 * copy of the strings (ConnectionSecurityCopy.kt), checked against
 * tests/fixtures/connection-security-copy.json, which
 * tests/unit/connection-security.test.ts keeps equal to CONNECTION_SECURITY_COPY.
 */
import { CERT_PIN_PARAM, isCertFingerprint, isLoopbackHost } from './transport-security'

/** Characters of the certificate SHA-256 shown for a by-eye comparison. */
export const SHORT_FINGERPRINT_LENGTH = 8

/** First 8 lowercase hex of a certificate fingerprint, or null when it is not one. */
export function shortFingerprint(fingerprint: string | null | undefined): string | null {
  const fp = fingerprint?.toLowerCase()
  return fp && isCertFingerprint(fp) ? fp.slice(0, SHORT_FINGERPRINT_LENGTH) : null
}

/** The pinned fingerprint in a saved or scanned address, or null. */
export function fingerprintInUrl(url: string): string | null {
  const match = new RegExp(`[?&]${CERT_PIN_PARAM}=([^&#]*)`).exec(url)
  const fp = match?.[1].toLowerCase()
  return fp && isCertFingerprint(fp) ? fp : null
}

export type ConnectionSecurity =
  /** wss:// with the QR's certificate pinned. */
  | 'pinned'
  /** Plain ws:// to loopback or the emulator host: never leaves the device. */
  | 'local'
  /** Plain ws:// to another computer, allowed in an internal build. */
  | 'plain'
  /** The Cloud IAP tunnel, encrypted by Google. */
  | 'iap'
  /** Plain ws:// to another computer that this build will not dial. */
  | 'refused'
  /** The computer answered with another certificate than the pinned one. */
  | 'certificate-changed'

export interface ConnectionSecurityInput {
  kind: 'ws' | 'iap'
  url?: string
  /** This app can pin a certificate (false in an Expo binary without the native module). */
  canPin: boolean
  /** This build refuses to dial `url`. */
  refused: boolean
  /** The last dial failed on a certificate mismatch. */
  certificateChanged: boolean
}

export function connectionSecurity(input: ConnectionSecurityInput): ConnectionSecurity {
  if (input.kind === 'iap') return 'iap'
  if (input.certificateChanged) return 'certificate-changed'
  if (input.refused) return 'refused'
  const url = input.url ?? ''
  if (input.canPin && fingerprintInUrl(url)) return 'pinned'
  const host = /^wss?:\/\/(\[[^\]]*\]|[^/:?#]*)/i.exec(url.trim())?.[1]
  return host !== undefined && isLoopbackHost(host) ? 'local' : 'plain'
}

/** Rows listed under "Needs attention": only the user can fix them. */
export function needsAttention(security: ConnectionSecurity, status: string): boolean {
  return security === 'refused' || security === 'certificate-changed' || status === 'error'
}

/** States whose row shows the short fingerprint beside the name. */
export function showsFingerprint(security: ConnectionSecurity): boolean {
  return security === 'pinned' || security === 'certificate-changed'
}

/** States whose detail line starts with a lock. */
export function showsLock(security: ConnectionSecurity): boolean {
  return security === 'pinned' || security === 'iap'
}

/**
 * Every sentence the phones show for transport security. `{label}` and
 * `{fingerprint}` are filled with `fillCopy`.
 */
export const CONNECTION_SECURITY_COPY = {
  sectionLive: 'Live',
  sectionAttention: 'Needs attention',
  liveCount: '{live} of {total}',
  pinned: 'Encrypted',
  local: 'Not encrypted, local only',
  plain: 'Not encrypted',
  iap: 'Cloud IAP',
  refused: 'Needs encryption',
  certificateChanged: 'Certificate changed',
  refusedHint:
    'Not encrypted. This app only connects over an encrypted link. Update Switchboard on that computer and scan its new QR, or use Cloud IAP.',
  scanNewQr: 'Scan new QR',
  useCloudIap: 'Use Cloud IAP',
  certificateChangedBody:
    '{label} answered with a certificate that is not the one you paired with. Switchboard stopped connecting to it.',
  certificateExpectedTitle: 'Expected after a reinstall or reset',
  certificateExpectedBody: 'Scan its new QR from Settings, Devices & machines on that computer.',
  certificateExpectedInline:
    'After a reinstall or reset, scan its new QR from Settings, Devices & machines on that computer.',
  certificateUnexpectedTitle: 'Not expected?',
  certificateUnexpectedBody:
    'Someone on this network may be intercepting. Check that screen first: if it still shows {fingerprint}, do not scan.',
  scanQrAgain: 'Scan QR again',
  remove: 'Remove',
  removeMachine: 'Remove machine',
  notNow: 'Not now',
  oldQrTitle: 'QR from an older Switchboard',
  oldQrBody: 'Its address is not encrypted. This app only connects to another computer over an encrypted link.',
  noCertificate: 'no certificate',
  oldQrScanAgain: 'Scan again',
  oldQrScanAgainBody: 'Update Switchboard on that computer first. Its new QR is in Settings, Devices & machines.',
  oldQrCloudIap: 'Connect through Cloud IAP',
  oldQrCloudIapBody: 'For a Google Cloud VM. Sign in with Google, then pick the instance.',
  cancel: 'Cancel',
} as const

export type ConnectionSecurityCopyKey = keyof typeof CONNECTION_SECURITY_COPY

/** A copy string with its `{name}` placeholders filled. */
export function fillCopy(key: ConnectionSecurityCopyKey, values: Record<string, string | number> = {}): string {
  return CONNECTION_SECURITY_COPY[key].replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  )
}

/** The detail-line label for a state. */
export function securityLabel(security: ConnectionSecurity): string {
  switch (security) {
    case 'pinned':
      return CONNECTION_SECURITY_COPY.pinned
    case 'local':
      return CONNECTION_SECURITY_COPY.local
    case 'plain':
      return CONNECTION_SECURITY_COPY.plain
    case 'iap':
      return CONNECTION_SECURITY_COPY.iap
    case 'refused':
      return CONNECTION_SECURITY_COPY.refused
    case 'certificate-changed':
      return CONNECTION_SECURITY_COPY.certificateChanged
  }
}
