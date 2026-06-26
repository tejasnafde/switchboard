/**
 * Map raw updater errors to user-facing text. Network failures (offline,
 * DNS, timeouts) surface from electron-updater as scary `net::ERR_*` /
 * errno strings — show "No internet connection" instead. Other errors pass
 * through unchanged. Pure, so it's unit-tested without electron.
 */
const NETWORK_RE =
  /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|getaddrinfo|net::ERR/i

export function friendlyUpdateError(raw: string): string {
  return NETWORK_RE.test(raw) ? 'No internet connection' : raw
}
