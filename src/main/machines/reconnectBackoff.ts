/**
 * Exponential backoff (base * 2^(attempt-1)) capped at capMs, with optional
 * jitter so machines that dropped simultaneously (e.g. laptop wake) don't
 * reconnect in lockstep. `jitter` is a fraction of the delay: 0.25 spreads
 * the result across [delay * 0.75, delay * 1.25], clamped to capMs.
 */
export function reconnectDelay(
  attempt: number,
  opts: { baseMs: number; capMs: number; jitter?: number; rng?: () => number },
): number {
  const delay = Math.min(opts.capMs, opts.baseMs * 2 ** Math.max(0, attempt - 1))
  const jitter = opts.jitter ?? 0
  if (jitter <= 0) return delay
  const rng = opts.rng ?? Math.random
  // Cap applies to the final value too - jitter must not push past capMs.
  return Math.min(opts.capMs, Math.round(delay * (1 - jitter + rng() * 2 * jitter)))
}
