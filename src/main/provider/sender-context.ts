import { hostname } from 'node:os'
import type { DeviceSession } from '@shared/device-auth'
import { formatSenderLine, takesSenderLine, type SenderContext, type SenderSurface } from '@shared/sender-line'
import { listSessions } from '../backend/device-sessions'
import { currentBackendRequestContext, type BackendRequestContext } from '../backend/request-context'

export interface SenderEnvironment {
  /** True on the headless server an SSH machine runs. */
  headless: boolean
  machineName: string
  deviceSession: (id: string) => DeviceSession | undefined
}

/**
 * Who sent the request, read from what the host authenticated. A request with
 * no context came from this process, i.e. the desktop. On the headless server
 * a WebSocket client without a device session is the desktop app, which dials
 * it through the SSH tunnel.
 */
export function resolveSenderContext(
  request: BackendRequestContext | undefined,
  env: SenderEnvironment,
): SenderContext {
  const sshMachine = env.headless ? env.machineName : undefined
  let surface: SenderSurface = 'other'
  let deviceName: string | undefined
  let deviceKind: string | undefined
  if (request?.transport !== 'remote') {
    surface = 'desktop'
  } else if (request.deviceSessionId) {
    const session = env.deviceSession(request.deviceSessionId)
    const platform = session?.identity?.platform
    if (platform) surface = platform
    deviceName = session?.customName ?? session?.identity?.name ?? session?.label
    deviceKind = session?.identity?.model
  } else if (request.remoteHost === 'ws' && env.headless) {
    surface = 'desktop'
  }
  return {
    surface,
    deviceName,
    deviceKind,
    sshMachine,
    localhostReachesUser: surface === 'desktop' && !sshMachine,
  }
}

const liveEnvironment: SenderEnvironment = {
  headless: Boolean(process.env.SWITCHBOARD_REMOTE),
  machineName: hostname(),
  deviceSession: (id) => listSessions().find((s) => s.id === id),
}

/** The line for a turn the current request submits, or null when the turn takes none. */
export function senderLineForTurn(text: string, env: SenderEnvironment = liveEnvironment): string | null {
  if (!takesSenderLine(text)) return null
  return formatSenderLine(resolveSenderContext(currentBackendRequestContext(), env))
}
