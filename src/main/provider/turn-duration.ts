/**
 * Elapsed time of the turn that just ended, for the "Worked for" badge, and
 * the reset that stops a later event from reporting it twice. Every adapter
 * stamps `turnStartedAt` on sendTurn and ends a turn through this.
 */
export function takeTurnDuration(turn: { turnStartedAt: number | null }, now = Date.now()): number | undefined {
  const durationMs = turn.turnStartedAt != null ? now - turn.turnStartedAt : undefined
  turn.turnStartedAt = null
  return durationMs
}
