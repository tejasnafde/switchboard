/**
 * Map raw updater errors to user-facing text. Network failures (offline,
 * DNS, timeouts) surface from electron-updater as scary `net::ERR_*` /
 * errno strings - show "No internet connection" instead. Other errors pass
 * through unchanged. Pure, so it's unit-tested without electron.
 */
const NETWORK_RE =
  /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|getaddrinfo|net::ERR/i

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

/** True when the check passed its deadline but is still running. */
export function isCheckTimeout(raw: string): boolean {
  return CHECK_TIMEOUT_RE.test(raw)
}

export function friendlyUpdateError(raw: string): string {
  if (NETWORK_RE.test(raw)) return 'No internet connection'
  if (isStaleDownloadError(raw)) return 'Update download was interrupted - try again'
  // Not a failure: the request is still in flight and its real status
  // overwrites this. Measured, a slow path finished the check at ~77s.
  if (CHECK_TIMEOUT_RE.test(raw)) return 'Still checking. This network is slow to reach GitHub, so it will finish in the background.'
  return raw
}
