/**
 * A message sent while the agent is working is either steered into the
 * running turn (the agent reads it at its next step) or queued until the turn
 * ends. Claude and Codex accept a steer natively: Claude's SDK reads a
 * mid-turn message at the next tool boundary, Codex takes `turn/steer`.
 * OpenCode cannot take a mid-turn message, so everything it gets is queued.
 * Queueing is done by the backend: the client sends at once with
 * `delivery: 'queue'` and the adapter holds the message until the running
 * turn ends (see `QueuedTurnSummary` for what a client can do meanwhile).
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

/** Settings key for what a plain Enter does while the agent works. */
export const FOLLOW_UP_DEFAULT_KEY = 'chat.followUpDefault'

/** Anything but an explicit `queue` means steer, which is what Enter always did. */
export function parseFollowUpDefault(value: string | null | undefined): TurnDelivery {
  return value === 'queue' ? 'queue' : 'steer'
}

/**
 * The delivery a mid-turn send asks for: Enter (and the Send button) takes
 * the user's default, the second shortcut (Alt/Option+Enter) the other one.
 */
export function followUpDelivery(preferred: TurnDelivery, alternate: boolean): TurnDelivery {
  if (!alternate) return preferred
  return preferred === 'steer' ? 'queue' : 'steer'
}

const DELIVERY_LABEL: Record<TurnDelivery, string> = { steer: 'Steer', queue: 'Queue' }

export interface SendAction {
  /** Accessible name of the send button. */
  label: string
  /** Tooltip: names the keys for both behaviours where both exist. */
  tooltip: string
}

/**
 * What the composer's one send button does and says. Idle it sends. While a
 * turn runs it does the user's default follow-up and names the other one's
 * key, except on a provider that cannot steer, where it always queues.
 */
export function sendAction(provider: string | undefined | null, running: boolean, preferred: TurnDelivery): SendAction {
  if (!running) return { label: 'Send', tooltip: 'Send (Enter)' }
  if (!canSteer(provider)) {
    return { label: 'Queue', tooltip: 'Queue (Enter): OpenCode cannot take a message mid-turn, so it runs after this turn' }
  }
  const other = followUpDelivery(preferred, true)
  return {
    label: DELIVERY_LABEL[preferred],
    tooltip: `${DELIVERY_LABEL[preferred]} (Enter) · ${DELIVERY_LABEL[other]} (⌥Enter)`,
  }
}

/**
 * Does an accepted send start a provider turn of its own, one the registry
 * waits on a `turn.completed` for? A Codex steer joins the running turn and
 * does not; everything else does, including a queued message, which becomes
 * its own turn once the running one ends.
 */
export function startsOwnProviderTurn(provider: string, midTurn: boolean, delivery: TurnDelivery | undefined): boolean {
  return provider !== 'codex' || !midTurn || delivery === 'queue'
}

/**
 * A queued message leaving the queue. `started`: it is now running as its own
 * turn. `promoted`: it was steered into the running turn. `cancelled`: the
 * user took it back. `dropped`: the session stopped before it could run.
 */
export type QueuedTurnExit = 'started' | 'promoted' | 'cancelled' | 'dropped'

/**
 * The registry counted a queued message as an outstanding turn when it was
 * accepted. Taking it out of the queue releases that count when no
 * `turn.completed` will ever arrive for it: cancelled, or promoted into a turn
 * it joins rather than starts (a Codex steer). A Claude steer is a turn of
 * its own, so a promoted Claude message keeps its count. (`started` keeps it
 * too, and `dropped` is settled by the adapter's own `turn.completed`.)
 */
export function releasesOutstandingTurn(provider: string, exit: 'promoted' | 'cancelled'): boolean {
  if (exit === 'cancelled') return true
  return !startsOwnProviderTurn(provider, true, 'steer')
}

/**
 * A message the backend holds until the running turn ends. `messageId` is the
 * id of the chat row every client already shows for it (`echoMessageId` of
 * the submission's origin), so a client marks that row rather than adding one.
 */
export interface QueuedTurnSummary {
  threadId: string
  messageId: string
  /** What the user typed, for putting back in the composer on cancel. */
  text: string
  queuedAt: number
}

export type QueuedTurnActionResult =
  | { ok: true; turn: QueuedTurnSummary }
  | { ok: false; reason: 'not-found' | 'unsupported' | 'failed'; message: string }

/** Why a queued message cannot be sent now, or null when it can. */
export function promoteUnavailableReason(provider: string | undefined | null): string | null {
  return canSteer(provider) ? null : 'OpenCode cannot take a message mid-turn, so this waits for the turn to end.'
}
