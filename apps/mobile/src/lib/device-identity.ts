/**
 * The identity this phone sends on every `auth` frame (rules in
 * `@shared/device-identity`), so the desktop can tell paired phones apart and
 * replace the session an earlier pairing of this phone left behind.
 *
 * JS only (expo-secure-store, expo-crypto, expo-application and Platform are
 * already in the binary), so it ships by OTA. Without expo-device the model is
 * the device class ("iPhone", "iPad"): iOS does not give an app the user's
 * device name without an entitlement anyway.
 */
import { Platform } from 'react-native'
import * as Application from 'expo-application'
import * as SecureStore from 'expo-secure-store'
import { parseDeviceIdentity, type DeviceIdentity } from '@shared/device-identity'
import { createLogger } from '@shared/logger'

const log = createLogger('mobile:device-identity')

const INSTALL_ID_KEY = 'sb-install-id'

/** The keychain outlives an uninstall on iOS, so a reinstalled app keeps its
 *  id and its next pairing replaces the old row. THIS_DEVICE_ONLY keeps it off
 *  a new phone restored from a backup, which must not replace this one. */
const INSTALL_ID_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
}

export interface DeviceFacts {
  os: string
  osVersion?: string | number
  /** iOS: 'phone' | 'pad' | 'tv' | ... from Platform.constants. */
  interfaceIdiom?: string
  /** Android only: Platform.constants.Manufacturer / Model. */
  manufacturer?: string
  model?: string
  appVersion?: string | null
}

const IDIOM_MODEL: Record<string, string> = { phone: 'iPhone', pad: 'iPad', tv: 'Apple TV', vision: 'Apple Vision' }

/** Pure: the payload for these facts. Null on a platform the backend does not
 *  name, or when the install id is unusable. */
export function deviceIdentityFrom(installId: string, facts: DeviceFacts): DeviceIdentity | null {
  const osVersion = facts.osVersion === undefined ? undefined : String(facts.osVersion)
  const appVersion = facts.appVersion ?? undefined
  if (facts.os === 'ios') {
    const model = IDIOM_MODEL[facts.interfaceIdiom ?? ''] ?? 'iPhone'
    return parseDeviceIdentity({
      installId,
      name: model,
      manufacturer: 'Apple',
      model,
      platform: 'ios',
      osVersion,
      appVersion,
    })
  }
  if (facts.os === 'android') {
    return parseDeviceIdentity({
      installId,
      name: facts.model,
      manufacturer: facts.manufacturer,
      model: facts.model,
      platform: 'android',
      osVersion,
      appVersion,
    })
  }
  return null
}

function currentFacts(): DeviceFacts {
  const constants = Platform.constants as unknown as Record<string, unknown>
  const pick = (key: string): string | undefined => (typeof constants[key] === 'string' ? constants[key] : undefined)
  return {
    os: Platform.OS,
    osVersion: Platform.OS === 'android' ? pick('Release') : Platform.Version,
    interfaceIdiom: pick('interfaceIdiom'),
    manufacturer: pick('Manufacturer'),
    model: pick('Model'),
    appVersion: Application.nativeApplicationVersion,
  }
}

async function readOrMintInstallId(): Promise<string> {
  const stored = await SecureStore.getItemAsync(INSTALL_ID_KEY, INSTALL_ID_OPTIONS)
  if (stored) return stored
  // Loaded here, not at the top: it binds a native module on import, and the
  // connection store (which imports this file) loads in places that have none.
  const Crypto = require('expo-crypto') as typeof import('expo-crypto')
  const minted = Crypto.randomUUID()
  await SecureStore.setItemAsync(INSTALL_ID_KEY, minted, INSTALL_ID_OPTIONS)
  return minted
}

let loading: Promise<DeviceIdentity | null> | null = null
let loaded: { identity: DeviceIdentity | null } | null = null

/** Resolves once per launch and never rejects: a keystore failure means the
 *  phone pairs as before, with no identity, rather than not at all. */
export function loadDeviceIdentity(): Promise<DeviceIdentity | null> {
  loading ??= readOrMintInstallId()
    .then((installId) => deviceIdentityFrom(installId, currentFacts()))
    .catch((err: unknown) => {
      log.warn('could not read or store the install id, pairing without a device identity', err)
      return null
    })
    .then((identity) => {
      loaded = { identity }
      return identity
    })
  return loading
}

/** The loaded identity, or undefined while `loadDeviceIdentity` is pending. */
export function loadedDeviceIdentity(): { identity: DeviceIdentity | null } | undefined {
  return loaded ?? undefined
}
