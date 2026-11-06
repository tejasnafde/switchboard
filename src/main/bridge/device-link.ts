/**
 * Runs the relay connection only while the `instinct_bridge` flag is on AND
 * this installation is enrolled (a device key in `bridge.device`), and stops
 * it when either turns off. Settings > Labs reads its status and enrolls or
 * removes the enrollment through the admin-scoped `bridge:*` channels.
 */
import { hostname } from 'node:os'
import {
  DEFAULT_BRIDGE_RELAY_ORIGIN,
  instinctBridgeEnabled,
  type BridgeCatalogProject,
  type BridgeDeviceStatus,
} from '@shared/bridge'
import { appVersion } from '../runtime'
import { getSetting, hubInstallId } from '../db/database'
import { createMainLogger } from '../logger'
import { allowedBridgeProjects, bridgeProjectAgents } from './read-service'
import {
  DeviceKeyError,
  defaultDeviceKeyDeps,
  deviceKeyStored,
  enrollDeviceKey,
  loadDeviceSigner,
  readDeviceKey,
  removeDeviceKey,
  setDeviceLabel,
  type DeviceKeyDeps,
} from './device-key'
import { BridgeRelayClient, resolveRelayOrigin, type RelayClientDeps, type RelayClientStatus } from './relay-client'

const log = createMainLogger('bridge:device-link')

export interface DeviceLinkDeps {
  env: NodeJS.ProcessEnv
  flagOn(): boolean
  machineId(): string
  keys: DeviceKeyDeps
  catalog(machineId: string): BridgeCatalogProject[]
  userAgent: string
  createClient(deps: RelayClientDeps): Pick<BridgeRelayClient, 'start' | 'stop' | 'sendCatalog' | 'status'>
}

/** The allowed projects as the relay sees them: ids, labels, agents and the mode cap. */
export function bridgeCatalog(machineId: string): BridgeCatalogProject[] {
  return allowedBridgeProjects(machineId).map(({ policy }) => ({
    project_id: policy.project_id,
    label: policy.label,
    default_agent: policy.default_agent,
    agents: bridgeProjectAgents(policy),
    maximum_mode: policy.maximum_mode,
  }))
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/** What the operator runs, from a Switchboard checkout, to register this desktop at the relay. */
export function operatorCommand(input: {
  origin: string
  machineId: string
  label: string
  publicKey: string
}): string {
  const env = input.origin === DEFAULT_BRIDGE_RELAY_ORIGIN ? '' : `BRIDGE_RELAY_ORIGIN=${shellQuote(input.origin)} `
  return `echo ${shellQuote(input.publicKey)} | ${env}node scripts/bridge-operator.mjs enroll ${shellQuote(input.machineId)} ${shellQuote(input.label)} -`
}

export function defaultDeviceLabel(): string {
  return hostname().replace(/\.local$/i, '').slice(0, 100) || 'This Mac'
}

export class BridgeDeviceLink {
  private client: ReturnType<DeviceLinkDeps['createClient']> | null = null
  private clientStatus: RelayClientStatus | null = null
  private keyError: string | null = null

  constructor(private readonly deps: DeviceLinkDeps) {}

  /** Start or stop the connection to match the flag and the enrollment. */
  reconcile(): void {
    const want = this.deps.flagOn() && readDeviceKey(this.deps.keys) !== null
    if (!want) {
      this.keyError = null
      return this.stopClient()
    }
    if (this.client) return
    const origin = resolveRelayOrigin(this.deps.env)
    if (!origin.ok) {
      this.keyError = 'bad_relay_origin'
      log.warn('bridge relay origin refused', { reason: origin.reason })
      return
    }
    const machineId = this.deps.machineId()
    let signer
    try {
      signer = loadDeviceSigner(this.deps.keys)
    } catch (err) {
      this.keyError = err instanceof DeviceKeyError ? err.code : 'key_unreadable'
      log.warn('bridge device key not usable', { code: this.keyError })
      return
    }
    if (!signer) return
    if (signer.machineId !== machineId) {
      this.keyError = 'machine_id_changed'
      log.warn('the bridge device key belongs to another machine id; enroll again')
      return
    }
    this.keyError = null
    this.clientStatus = null
    this.client = this.deps.createClient({
      origin: origin.origin,
      machineId,
      sign: signer.sign,
      catalog: () => this.deps.catalog(machineId),
      userAgent: this.deps.userAgent,
      onStatus: (status) => {
        this.clientStatus = status
      },
    })
    log.info('bridge relay connection starting')
    this.client.start()
  }

  private stopClient(): void {
    if (!this.client) return
    this.client.stop()
    this.client = null
    this.clientStatus = null
    log.info('bridge relay connection stopped')
  }

  stop(): void {
    this.stopClient()
  }

  catalogChanged(): void {
    this.client?.sendCatalog()
  }

  enroll(label: string): BridgeDeviceStatus {
    if (!this.deps.flagOn()) throw new Error('The Instinct bridge is off in Settings > Labs.')
    enrollDeviceKey(this.deps.machineId(), label, this.deps.keys)
    this.reconcile()
    return this.status()
  }

  setLabel(label: string): BridgeDeviceStatus {
    setDeviceLabel(label, this.deps.keys)
    return this.status()
  }

  removeEnrollment(): BridgeDeviceStatus {
    this.stopClient()
    removeDeviceKey(this.deps.keys)
    this.keyError = null
    return this.status()
  }

  status(): BridgeDeviceStatus {
    const enabled = this.deps.flagOn()
    const key = readDeviceKey(this.deps.keys)
    const stored = deviceKeyStored(this.deps.keys)
    const origin = resolveRelayOrigin(this.deps.env)
    const relayOrigin = origin.ok ? origin.origin : null
    const base: BridgeDeviceStatus = {
      enabled,
      enrolled: stored,
      machine_id: key?.machineId ?? this.deps.machineId(),
      label: key?.label ?? null,
      public_key: key?.publicKey ?? null,
      key_fingerprint: key?.fingerprint ?? null,
      relay_origin: relayOrigin,
      state: 'off',
      code: null,
      connection_generation: null,
      operator_command:
        key && relayOrigin
          ? operatorCommand({ origin: relayOrigin, machineId: key.machineId, label: key.label, publicKey: key.publicKey })
          : null,
    }
    if (!enabled) return base
    if (!stored) return { ...base, state: 'not_enrolled' }
    if (!key) return { ...base, state: 'key_unreadable', code: 'unknown_format' }
    if (this.keyError) return { ...base, state: 'key_unreadable', code: this.keyError }
    const live = this.clientStatus ?? this.client?.status() ?? null
    if (!live) return { ...base, state: 'connecting' }
    return { ...base, state: live.state, code: live.code, connection_generation: live.connectionGeneration }
  }
}

let link: BridgeDeviceLink | null = null

export function bridgeDeviceLink(): BridgeDeviceLink {
  link ??= new BridgeDeviceLink({
    env: process.env,
    flagOn: () => instinctBridgeEnabled(process.env, getSetting),
    machineId: hubInstallId,
    keys: defaultDeviceKeyDeps,
    catalog: bridgeCatalog,
    userAgent: `Switchboard/${appVersion()}`,
    createClient: (deps) => new BridgeRelayClient(deps),
  })
  return link
}

export function stopBridgeDeviceLink(): void {
  link?.stop()
}
