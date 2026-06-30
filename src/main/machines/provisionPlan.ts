/**
 * Decide what provisioning a remote needs before we can run the backend on it,
 * from the ssh probe + the local server version. Pure - the orchestrator acts
 * on the action (ssh upload / launch) and surfaces the reason.
 */
import type { RemoteProbe } from './remoteProbe'

export type ProvisionAction = 'ready' | 'install' | 'upgrade' | 'no-node'

export function planProvision(probe: RemoteProbe, localVersion: string): { action: ProvisionAction; reason: string } {
  if (!probe.node) return { action: 'no-node', reason: 'no node runtime found on the remote' }
  if (!probe.server) return { action: 'install', reason: 'no switchboard-server installed' }
  if (probe.server !== localVersion) {
    return { action: 'upgrade', reason: `server ${probe.server} != app ${localVersion}` }
  }
  return { action: 'ready', reason: `server ${probe.server} up to date` }
}
