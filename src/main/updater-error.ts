/**
 * Map raw updater errors to one short user-facing sentence. The raw text
 * never reaches the UI: electron-updater's HttpError carries the signed asset
 * URL (a credential while it lives), the CDN's HTML body and every header.
 * The full error goes to the log only, through `redactUpdateLog`. Pure, so
 * it's unit-tested without electron.
 */
const OFFLINE_RE = /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i

/**
 * GitHub's release CDN or the path to it failed, and a later try usually
 * works: a stale signed link (618 jwt:expired), a 5xx, a dropped or
 * stalled connection.
 */
const SERVER_RE =
  /(?:^|HttpError: )(?:5\d\d|618)\b|\bstatus(?:Code)?:? (?:5\d\d|618)\b|jwt:expired|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ERR_CONNECTION|ERR_NETWORK_CHANGED|ERR_TIMED_OUT|net::ERR/i

/** Retried once by the updater before the user sees anything. */
const TRANSIENT_RE =
  /(?:^|HttpError: )(?:5\d\d|618)\b|\bstatus(?:Code)?:? (?:5\d\d|618)\b|jwt:expired|ETIMEDOUT|ECONNRESET/i

const SERVER_ERROR_TEXT = "GitHub's download server had a problem. Try again in a minute."
const OFFLINE_TEXT = 'No internet connection.'
const GENERIC_TEXT = "Couldn't check for updates. Try again later."

/** Wait before the one automatic retry of a transient failure. */
export const UPDATE_RETRY_DELAY_MS = 5_000

/** True when `attempt` (1-based) failed with `raw` and one more try is worth it. */
export function shouldRetryUpdateError(raw: string, attempt: number): boolean {
  return attempt === 1 && TRANSIENT_RE.test(raw)
}

/**
 * Strip what makes a logged updater error a credential: the query string of
 * every URL (GitHub's signed asset links carry `jwt=`, `sig=` and friends),
 * any bare JWT, and token or authorization values in headers.
 */
export function redactUpdateLog(raw: string): string {
  return raw
    .replace(/(https?:\/\/[^\s?"'<>]+)\?[^\s"'<>]*/gi, '$1?<redacted>')
    .replace(/eyJ[\w-]+\.[\w-]+(?:\.[\w-]*)?/g, '<jwt>')
    .replace(/((?:jwt|token|sig|signature|x-amz-[\w-]+)=)[^&\s"'<>]+/gi, '$1<redacted>')
    .replace(
      /((?:authorization|[\w-]*token)['"]?\s*[:=]\s*['"]?)(?:(?:Bearer|Basic|token)\s+)?[^'",\s}]+/gi,
      '$1<redacted>',
    )
}

/**
 * The download landed but its `temp-<asset>` file was gone by the time
 * electron-updater renamed it into place. That staging area lives under
 * `~/Library/Caches/switchboard-updater/pending`, which macOS is free to purge
 * under disk pressure - and a full update asset sits there for the whole
 * download. electron-updater only retries EBUSY on that rename
 * (AppUpdater.executeDownload), so a single vanish loses the download and
 * surfaces the raw errno. Transient by nature: re-downloading fixes it.
 */
const STALE_DOWNLOAD_RE = /ENOENT[\s\S]*rename[\s\S]*temp-/i

export function isStaleDownloadError(raw: string): boolean {
  return STALE_DOWNLOAD_RE.test(raw)
}

/**
 * Our own `withTimeout` wrapper around `checkForUpdates()` produced this.
 * electron-updater caches the in-flight check promise, so once a check
 * hangs, every retry click awaits the same hung request - only an app
 * restart truly resets it. The message must name that escape hatch.
 */
const CHECK_TIMEOUT_RE = /^Update check timed out after \d+ms$/

const MISSING_MANIFEST_RE =
  /(?:latest-mac\.yml|latest\.yml)[\s\S]*(?:404|not found)|(?:404|not found)[\s\S]*(?:latest-mac\.yml|latest\.yml)/i

export function isMissingUpdateManifestError(raw: string): boolean {
  return MISSING_MANIFEST_RE.test(raw)
}

/** True when the check passed its deadline but is still running. */
export function isCheckTimeout(raw: string): boolean {
  return CHECK_TIMEOUT_RE.test(raw)
}

export function friendlyUpdateError(raw: string): string {
  if (OFFLINE_RE.test(raw)) return OFFLINE_TEXT
  if (isStaleDownloadError(raw)) return 'Update download was interrupted - try again'
  // Before the manifest check: a 618 body can contain "404" in a signed URL.
  if (SERVER_RE.test(raw)) return SERVER_ERROR_TEXT
  if (isMissingUpdateManifestError(raw)) {
    return 'The latest desktop release is missing its update manifest. Install from the release page or try again after the release is repaired.'
  }
  // Not a failure: the request is still in flight and its real status
  // overwrites this. Measured, a slow path finished the check at ~77s.
  if (CHECK_TIMEOUT_RE.test(raw))
    return 'Still checking. This network is slow to reach GitHub, so it will finish in the background.'
  return GENERIC_TEXT
}
