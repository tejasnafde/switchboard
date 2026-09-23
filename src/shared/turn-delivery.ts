/**
 * A message sent while the agent is working is either steered into the
 * running turn (the agent reads it at its next step) or queued until the turn
 * ends. Claude and Codex accept a steer natively: Claude's SDK reads a
 * mid-turn message at the next tool boundary, Codex takes `turn/steer`.
 * OpenCode cannot take a mid-turn message, so everything it gets is queued.
 * Queueing is done by the client, which holds the message and sends it
 * through the ordinary path once the turn is over.
 */
export type TurnDelivery = 'steer' | 'queue'

/** Accepts either spelling of Claude (`claude` / `claude-code`). */
export function canSteer(provider: string | undefined | null): boolean {
  return provider !== 'opencode' && provider !== 'terminal'
}

/** Should a message sent now wait for the running turn to end? */
export function waitsForIdle(provider: string | undefined | null, busy: boolean, delivery: TurnDelivery): boolean {
  return busy && (delivery === 'queue' || !canSteer(provider))
}
