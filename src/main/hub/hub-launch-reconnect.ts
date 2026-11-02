/**
 * At desktop launch, connect each saved machine that holds open (starting or
 * open) children of this desktop's hubs, through the normal connect path; its
 * on-connect pending-stop flush and outbox pull then run as on any connect.
 * Off with `hub_remote_children` off or `hub.reconnectOnLaunch` set to false.
 * A connect never prompts (ssh runs with BatchMode): one that needs a login or
 * a host key fails, retries on the connection's own backoff, and the machine
 * stays offline.
 *
 * Measured: one `hub.remote-launch-reconnect` line (machines tried, connected, ms).
 */
import type { ConnectionStatus } from '../machines/connection-status'
import { createMainLogger } from '../logger'
import { perfSpan } from '../perf'

const log = createMainLogger('hub:launch-reconnect')

export interface LaunchReconnectDeps {
  flagOn: () => boolean
  /** The `hub.reconnectOnLaunch` row: anything but 'false' is on. */
  setting: () => string | null
  /** The machine ids of open children of this desktop's hubs (`hub_children.machine_id`). */
  openChildMachineIds: () => readonly string[]
  savedMachineIds: () => readonly string[]
  statusOf: (machineId: string) => ConnectionStatus
  connect: (machineId: string) => Promise<void>
}

/** The saved machines to connect at launch, in first-child order; none when off. */
export function machinesToReconnect(d: Omit<LaunchReconnectDeps, 'connect'>): string[] {
  if (!d.flagOn() || d.setting() === 'false') return []
  const saved = new Set(d.savedMachineIds())
  const ids = [...new Set(d.openChildMachineIds())]
  return ids.filter((id) => saved.has(id) && d.statusOf(id) === 'offline')
}

export async function reconnectOnLaunch(d: LaunchReconnectDeps): Promise<void> {
  let ids: string[]
  try {
    ids = machinesToReconnect(d)
  } catch (err) {
    log.warn('could not read the machines with open children; none is connected at launch', err)
    return
  }
  if (ids.length === 0) return
  const span = perfSpan('hub.remote-launch-reconnect', { machines: ids.length })
  await Promise.all(
    ids.map((id) => d.connect(id).catch((err) => log.warn(`launch connect of machine ${id} failed`, err))),
  )
  span.end({ connected: ids.filter((id) => d.statusOf(id) === 'connected').length })
}
