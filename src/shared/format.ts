/**
 * Shared display formatters. Pure, no DOM, no Electron, safe in any process.
 */

/**
 * Human-friendly turn duration. Same rough vocabulary as Cursor's "Worked for
 * 2s" indicator. We choose 1-decimal seconds under a minute so quick turns
 * feel responsive; minutes/hours get integer parts only.
 *
 *   200    → "0.2s"
 *   1400   → "1.4s"
 *   65000  → "1m 5s"
 *   3.9e6  → "1h 5m"
 */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0.0s'
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000)
    const s = Math.floor((ms % 60_000) / 1000)
    return `${m}m ${s}s`
  }
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return `${h}h ${m}m`
}
