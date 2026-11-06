/**
 * Settings > Labs > Instinct bridge projects: list the sidebar's projects with
 * whether the bridge may open each, and switch one. `bridge:*` is `admin`
 * scoped (device-auth), so only the desktop reaches these. Both refuse to
 * change anything while the flag is off.
 */
import { instinctBridgeEnabled, type BridgeProjectSetup } from '@shared/bridge'
import { BridgeChannels } from '@shared/ipc-channels'
import type { BackendHost } from '../backend/host'
import { getSetting } from '../db/database'
import { listBridgeProjectSetup, removeBridgeProject, setBridgeProjectAllowed } from '../bridge/allowlist'

function assertEnabled(): void {
  if (!instinctBridgeEnabled(process.env, getSetting)) throw new Error('The Instinct bridge is off in Settings > Labs.')
}

function setup(): BridgeProjectSetup {
  const enabled = instinctBridgeEnabled(process.env, getSetting)
  return { enabled, projects: enabled ? listBridgeProjectSetup() : [] }
}

export function registerBridgeHandlers(host: BackendHost): void {
  host.handle(BridgeChannels.LIST_PROJECTS, () => setup())
  host.handle(BridgeChannels.SET_PROJECT_ALLOWED, (input: unknown) => {
    const { path, allowed } = (input ?? {}) as { path?: unknown; allowed?: unknown }
    if (typeof path !== 'string' || typeof allowed !== 'boolean') throw new Error('Expected { path, allowed }.')
    assertEnabled()
    setBridgeProjectAllowed(path, allowed)
    return setup()
  })
  host.handle(BridgeChannels.REMOVE_PROJECT, (projectId: unknown) => {
    if (typeof projectId !== 'string') throw new Error('Expected a project id.')
    assertEnabled()
    removeBridgeProject(projectId)
    return setup()
  })
}
