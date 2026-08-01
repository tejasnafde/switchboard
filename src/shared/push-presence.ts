/**
 * Whether the user is at the machine that would be doing the pushing.
 *
 * The existing suppression is a per-thread viewing claim: the desktop says
 * "I have thread X open" and the backend skips pushing about X. Two things it
 * cannot cover, both of which are the normal way the app gets used:
 *
 *  - It is scoped to ONE thread. Run three agents, watch one, and the other two
 *    still buzz the phone in your pocket.
 *  - It keys off window focus, so Switchboard sitting behind an editor counts
 *    as having walked away.
 *
 * Presence answers the question actually being asked - is the user here - from
 * OS idle time, which is true whatever window is in front and whatever thread
 * is open.
 */

/**
 * Idle for longer than this and the user is treated as away.
 *
 * Two minutes rather than seconds: a push is worth sending when someone has
 * genuinely stepped away, and a threshold short enough to trip while reading a
 * diff would reintroduce the noise this exists to remove.
 */
export const PRESENCE_IDLE_LIMIT_MS = 120_000

export interface PresenceProbe {
  /** Milliseconds since the last input on this machine. */
  idleMs: () => number
}

export function isUserPresent(probe: PresenceProbe | null, limitMs = PRESENCE_IDLE_LIMIT_MS): boolean {
  // No probe means no way to tell, and guessing "present" would silently
  // disable push on a headless server, where nobody is ever at the machine.
  if (!probe) return false
  return probe.idleMs() < limitMs
}
