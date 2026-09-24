/**
 * Pure connect-lifecycle transition shared by the connection manager and the
 * sidebar pip. Keeps the state machine in one tested place.
 */
export type ConnectionStatus = 'offline' | 'connecting' | 'connected' | 'error'
export type ConnectionEvent = 'connect' | 'healthy' | 'fail' | 'disconnect'

export function nextConnectionStatus(current: ConnectionStatus, event: ConnectionEvent): ConnectionStatus {
  switch (event) {
    case 'connect':
      return current === 'connected' ? 'connected' : 'connecting'
    case 'healthy':
      return current === 'connecting' ? 'connected' : current
    case 'fail':
      return 'error'
    case 'disconnect':
      return 'offline'
  }
}
