/** Exponential backoff (base * 2^(attempt-1)) capped at capMs. */
export function reconnectDelay(attempt: number, opts: { baseMs: number; capMs: number }): number {
  return Math.min(opts.capMs, opts.baseMs * 2 ** Math.max(0, attempt - 1))
}
