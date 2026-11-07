/**
 * Settings > Labs > Instinct bridge: list the sidebar's projects with whether
 * the bridge may open each, switch one, pick the named checks a project
 * measures, and enroll this desktop with the relay. `bridge:*` is `admin` scoped (device-auth), so only the desktop
 * reaches these. Changes refuse while the flag is off, except removing the
 * enrollment and the stop controls.
 */
import { instinctBridgeEnabled, type BridgeChecksSetup, type BridgeProjectSetup } from '@shared/bridge'
import { BridgeChannels } from '@shared/ipc-channels'
import type { BackendHost } from '../backend/host'
import { getSetting } from '../db/database'
import {
  listBridgeChecksSetup,
  listBridgeProjectSetup,
  removeBridgeProject,
  setBridgeProjectAllowed,
  setBridgeProjectChecks,
} from '../bridge/allowlist'
import { bridgeDeviceLink, defaultDeviceLabel } from '../bridge/device-link'
import { bridgeStopService, type BridgeStopService } from '../bridge/stop-service'

function assertEnabled(): void {
  if (!instinctBridgeEnabled(process.env, getSetting)) throw new Error('The Instinct bridge is off in Settings > Labs.')
}

function labelOf(input: unknown): string {
  const { label } = (input ?? {}) as { label?: unknown }
  if (label !== undefined && typeof label !== 'string') throw new Error('Expected { label }.')
  return label?.trim() || defaultDeviceLabel()
}

function stops(): BridgeStopService {
  const service = bridgeStopService()
  if (!service) throw new Error('The bridge stop controls run only on the desktop.')
  return service
}

function setup(): BridgeProjectSetup {
  const enabled = instinctBridgeEnabled(process.env, getSetting)
  return { enabled, projects: enabled ? listBridgeProjectSetup() : [] }
}

function checksSetup(): BridgeChecksSetup {
  const enabled = instinctBridgeEnabled(process.env, getSetting)
  return { enabled, projects: enabled ? listBridgeChecksSetup() : [] }
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
  host.handle(BridgeChannels.LIST_CHECKS, () => checksSetup())
  host.handle(BridgeChannels.SET_CHECKS, (input: unknown) => {
    const { projectId, checks } = (input ?? {}) as { projectId?: unknown; checks?: unknown }
    if (typeof projectId !== 'string' || !Array.isArray(checks)) throw new Error('Expected { projectId, checks }.')
    assertEnabled()
    setBridgeProjectChecks(projectId, checks)
    return checksSetup()
  })
  host.handle(BridgeChannels.DEVICE_STATUS, () => bridgeDeviceLink().status())
  host.handle(BridgeChannels.ENROLL_DEVICE, (input: unknown) => bridgeDeviceLink().enroll(labelOf(input)))
  host.handle(BridgeChannels.SET_DEVICE_LABEL, (input: unknown) => bridgeDeviceLink().setLabel(labelOf(input)))
  host.handle(BridgeChannels.REMOVE_DEVICE, () => bridgeDeviceLink().removeEnrollment())
  // Not behind the flag: stopping and its status keep working for existing bridge origins.
  host.handle(BridgeChannels.STOP_STATUS, () => stops().status())
  host.handle(BridgeChannels.STOP_ALL, () => stops().stopAll())
  host.handle(BridgeChannels.CLEAR_KILL, () => stops().clearLocalKill())
}
