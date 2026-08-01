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

/** Compact token counts: 850 → "850", 4500 → "4.5k", 1_500_000 → "1.5M". */
export function formatTokens(tokens: number | null): string {
  if (tokens === null) return '?'
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

/** Compact relative timestamps for list rows: now / 5m / 3h / 2d / 4w / 3mo. */
export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  const months = Math.floor(days / 30)
  // 28-30 days: already "4w" but not yet a full month - keep weeks, never "0mo".
  if (months < 1) return `${weeks}w`
  return `${months}mo`
}
