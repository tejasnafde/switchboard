import type { WebSocketServer } from 'ws'
import { WsHost } from '../main/backend/ws-host'
import { PHONE_SCOPES } from '@shared/device-auth'

/**
 * The headless backend's WebSocket host.
 *
 * The pairing token is printed in the QR a phone scans, so it is a phone
 * credential: PHONE_SCOPES, no terminal, no `admin` (agent secrets, pairing,
 * source control). The desktop token grants every scope and is printed apart
 * from the QR, for `SWITCHBOARD_BACKEND_URL`.
 *
 * With no tokens (a loopback bind) every connection gets every scope. That is
 * the ssh -L forward the desktop's managed machines dial, and it is the same
 * trust boundary as the PTY this server spawns: a local process of that user
 * can already read the server's files and secrets. Another account on a shared
 * VM can reach the port too, and it already gets a shell that way, so a
 * secret answer adds nothing it could not do. Bind with a token on such a VM.
 */
export function createHeadlessWsHost(
  wss: WebSocketServer,
  credentials: { pairingToken?: string; desktopToken?: string },
): WsHost {
  return new WsHost(wss, credentials.pairingToken, undefined, false, PHONE_SCOPES, credentials.desktopToken)
}
