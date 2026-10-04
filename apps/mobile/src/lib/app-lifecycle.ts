export type ForegroundAction = 'probe' | 'reconnect'

/** Absence is not proof a socket died. A failed heartbeat probe redials it. */
export function foregroundAction(_backgroundedAtMs: number | null, _activeAtMs: number): ForegroundAction {
  return 'probe'
}
