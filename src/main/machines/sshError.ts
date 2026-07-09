/**
 * Turn raw ssh stderr into a single meaningful line for the UI.
 *
 * gcloud IAP / ProxyCommand tunnels prepend noise before the real cause, e.g.:
 *
 *   WARNING: To increase the performance of the tunnel, consider installing NumPy...
 *   Host key verification failed.
 *
 * Dumping all of that (or just the first line) hides the actual failure. We drop
 * known-noise lines and prefer a line matching a recognised ssh failure; if none
 * matches we fall back to the last non-noise line (ssh prints the fatal cause last),
 * and only then to the raw text.
 */

/** Lines that are progress/informational chatter, never the cause of a failure. */
const NOISE = [
  /^warning:/i, // gcloud NumPy perf warning, deprecation notices, etc.
  /numpy/i,
  /^authenticated to /i,
  /^connection to .* closed/i,
  /^shared connection to /i,
  /^pseudo-terminal/i,
  /^bind:/i,
  /^debug\d*:/i,
  /^starting.*tunnel/i,
  /^listening on port/i,
  /^testing if tunnel/i,
  // gcloud IAP prints an upload-bandwidth advisory on teardown; it is never
  // the cause of a failure (seen live: it became the "reason" for a killed tunnel).
  /^please see https:/i,
  /increasing the tcp upload bandwidth/i,
]

/** Recognised ssh failure lines, most-specific cause first. */
const CAUSES = [
  /host key verification failed/i,
  /permission denied/i,
  /connection refused/i,
  /connection timed out/i,
  /could not resolve hostname/i,
  /no route to host/i,
  /network is unreachable/i,
  /operation timed out/i,
  /remote host identification has changed/i,
  /proxycommand.*failed/i,
  /command not found/i,
]

export function summarizeSshError(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  if (lines.length === 0) return ''

  const signal = lines.filter((l) => !NOISE.some((n) => n.test(l)))

  for (const pattern of CAUSES) {
    const hit = signal.find((l) => pattern.test(l))
    if (hit) return hit
  }

  // No recognised cause: ssh prints the fatal line last, so prefer the last
  // non-noise line. If EVERYTHING was noise there is no cause to report -
  // return empty rather than leaking an advisory (seen live: a killed IAP
  // tunnel's only stderr was the NumPy/bandwidth notice, which then rendered
  // as the machine's error reason).
  return signal.length > 0 ? signal[signal.length - 1] : ''
}
