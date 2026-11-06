/**
 * Settings > Labs > Instinct bridge: list the sidebar's projects with whether
 * the bridge may open each, switch one, and enroll this desktop with the
 * relay. `bridge:*` is `admin` scoped (device-auth), so only the desktop
 * reaches these. Changes refuse while the flag is off, except removing the
 * enrollment.
 */
import { instinctBridgeEnabled, type BridgeProjectSetup } from '@shared/bridge'
import { BridgeChannels } from '@shared/ipc-channels'
import type { BackendHost } from '../backend/host'
import { getSetting } from '../db/database'
import { listBridgeProjectSetup, removeBridgeProject, setBridgeProjectAllowed } from '../bridge/allowlist'
import { bridgeDeviceLink, defaultDeviceLabel } from '../bridge/device-link'

function assertEnabled(): void {
  if (!instinctBridgeEnabled(process.env, getSetting)) throw new Error('The Instinct bridge is off in Settings > Labs.')
}

function labelOf(input: unknown): string {
  const { label } = (input ?? {}) as { label?: unknown }
  if (label !== undefined && typeof label !== 'string') throw new Error('Expected { label }.')
  return label?.trim() || defaultDeviceLabel()
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
    bridgeDeviceLink().catalogChanged()
    return setup()
  })
  host.handle(BridgeChannels.REMOVE_PROJECT, (projectId: unknown) => {
    if (typeof projectId !== 'string') throw new Error('Expected a project id.')
    assertEnabled()
    removeBridgeProject(projectId)
    bridgeDeviceLink().catalogChanged()
    return setup()
  })
  host.handle(BridgeChannels.DEVICE_STATUS, () => bridgeDeviceLink().status())
  host.handle(BridgeChannels.ENROLL_DEVICE, (input: unknown) => bridgeDeviceLink().enroll(labelOf(input)))
  host.handle(BridgeChannels.SET_DEVICE_LABEL, (input: unknown) => bridgeDeviceLink().setLabel(labelOf(input)))
  host.handle(BridgeChannels.REMOVE_DEVICE, () => bridgeDeviceLink().removeEnrollment())
}
