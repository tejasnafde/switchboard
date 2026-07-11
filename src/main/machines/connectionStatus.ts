/**
 * Pure connect-lifecycle transition shared by the connection manager and the
 * sidebar pip. Keeps the state machine in one tested place.
 *
 * 'provisioning' is a sub-phase of connecting (bundle upload / npm install on
 * the remote); 'reconnecting' covers the automatic backoff + retry after an
 * established connection dropped, so the UI can render it as self-healing
 * instead of a terminal error.
 */
export type ConnectionStatus = 'offline' | 'connecting' | 'provisioning' | 'reconnecting' | 'connected' | 'error'
export type ConnectionEvent = 'connect' | 'provision' | 'retry' | 'healthy' | 'fail' | 'disconnect'

export function nextConnectionStatus(current: ConnectionStatus, event: ConnectionEvent): ConnectionStatus {
  switch (event) {
    case 'connect':
      if (current === 'connected') return 'connected'
      // A retry attempt keeps the 'reconnecting' badge for its whole duration -
      // flipping back to 'connecting' would hide that this is an auto-heal.
      if (current === 'reconnecting') return 'reconnecting'
      return 'connecting'
    case 'provision':
      if (current === 'connecting') return 'provisioning'
      if (current === 'reconnecting') return 'reconnecting'
      return current
    case 'retry':
      // Backoff scheduled after a failure with budget left. 'offline' means a
      // deliberate disconnect won the race - stay put.
      return current === 'offline' ? 'offline' : 'reconnecting'
    case 'healthy':
      return current === 'connecting' || current === 'provisioning' || current === 'reconnecting'
        ? 'connected'
        : current
    case 'fail':
      return 'error'
    case 'disconnect':
      return 'offline'
  }
}
