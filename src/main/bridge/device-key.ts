/**
 * This desktop's Instinct bridge device key: an ECDSA P-256 pair made on the
 * first enrollment. The public half is what the operator registers at the
 * relay; the private half signs the relay's challenge and is stored only
 * encrypted by Electron `safeStorage` (the OS keychain), with the same
 * sentinel as provider instance env. With no keychain it is not stored at
 * all. The machine id is the existing `hub.installId`.
 *
 * Stored in the backend settings row `bridge.device`, admin only for phones
 * (`ADMIN_ONLY_SETTING_FAMILIES`). Nothing here logs key material.
 */
import { createHash, createPrivateKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { getSafeStorage } from '../runtime'
import { getSetting, removeSetting, setSetting } from '../db/database'
import { createMainLogger } from '../logger'

const log = createMainLogger('bridge:device-key')

export const BRIDGE_DEVICE_SETTING = 'bridge.device'
// The provider instance env sentinel: \0SBE then the safeStorage ciphertext.
const ENC_MAGIC = Buffer.from([0x00, 0x53, 0x42, 0x45])
const MAX_LABEL_CHARS = 100

/** The stored row. `private_key` is base64 of ENC_MAGIC plus the safeStorage ciphertext of the PKCS#8 DER. */
interface StoredDeviceKey {
  v: 1
  machine_id: string
  label: string
  public_key: string
  private_key: string
  created_at: string
}

/** The public part of the enrollment. */
export interface DeviceKeyInfo {
  machineId: string
  label: string
  publicKey: string
  fingerprint: string
  createdAt: string
}

export interface DeviceSigner {
  machineId: string
  /** ECDSA SHA-256 over the UTF-8 text, 64 bytes r then s, base64. */
  sign(text: string): string
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(blob: Buffer): string
}

export interface DeviceKeyDeps {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
  removeSetting(key: string): void
  safeStorage(): SafeStorageLike | null
  now(): number
}

export const defaultDeviceKeyDeps: DeviceKeyDeps = {
  getSetting,
  setSetting,
  removeSetting,
  safeStorage: getSafeStorage,
  now: Date.now,
}

export type DeviceKeyErrorCode = 'encryption_unavailable' | 'key_unreadable'

export class DeviceKeyError extends Error {
  constructor(
    readonly code: DeviceKeyErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'DeviceKeyError'
  }
}

/** The first 16 hex characters of the SPKI's SHA-256, the relay's fingerprint. */
export function keyFingerprint(publicKey: string): string {
  return createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 16)
}

function cleanLabel(label: string): string {
  const trimmed = label.trim().replace(/\s+/g, ' ')
  if (!trimmed) throw new Error('The label is empty.')
  if (trimmed.length > MAX_LABEL_CHARS) throw new Error(`The label is longer than ${MAX_LABEL_CHARS} characters.`)
  return trimmed
}

function readStored(deps: DeviceKeyDeps): StoredDeviceKey | null {
  const raw = deps.getSetting(BRIDGE_DEVICE_SETTING)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<StoredDeviceKey>
    if (
      parsed.v === 1 &&
      typeof parsed.machine_id === 'string' &&
      typeof parsed.label === 'string' &&
      typeof parsed.public_key === 'string' &&
      typeof parsed.private_key === 'string' &&
      typeof parsed.created_at === 'string'
    )
      return parsed as StoredDeviceKey
  } catch (err) {
    log.warn('the bridge device row is not JSON (contents not logged)', err instanceof Error ? err.name : 'unknown')
    return null
  }
  log.warn('the bridge device row has an unknown shape (contents not logged)')
  return null
}

function info(stored: StoredDeviceKey): DeviceKeyInfo {
  return {
    machineId: stored.machine_id,
    label: stored.label,
    publicKey: stored.public_key,
    fingerprint: keyFingerprint(stored.public_key),
    createdAt: stored.created_at,
  }
}

/** A `bridge.device` row exists, readable or not (another version's format). */
export function deviceKeyStored(deps: DeviceKeyDeps = defaultDeviceKeyDeps): boolean {
  return deps.getSetting(BRIDGE_DEVICE_SETTING) !== null
}

/** The enrollment without decrypting anything, or null when there is none this build can read. */
export function readDeviceKey(deps: DeviceKeyDeps = defaultDeviceKeyDeps): DeviceKeyInfo | null {
  const stored = readStored(deps)
  return stored ? info(stored) : null
}

/**
 * Makes and stores the key pair, or answers the existing enrollment unchanged.
 * Refuses with `encryption_unavailable` when the keychain cannot encrypt: the
 * private key is never written in plaintext.
 */
export function enrollDeviceKey(
  machineId: string,
  label: string,
  deps: DeviceKeyDeps = defaultDeviceKeyDeps,
): DeviceKeyInfo {
  const existing = readStored(deps)
  if (existing) return info(existing)
  // Never overwrite a key another version stored: removing it is the owner's choice.
  if (deviceKeyStored(deps))
    throw new DeviceKeyError('key_unreadable', 'A device key this version cannot read is stored. Remove it first.')
  const safeStorage = deps.safeStorage()
  if (!safeStorage?.isEncryptionAvailable())
    throw new DeviceKeyError(
      'encryption_unavailable',
      'This computer cannot encrypt the device key (no keychain), so it was not made.',
    )
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' })
  const sealed = Buffer.concat([ENC_MAGIC, safeStorage.encryptString(pkcs8.toString('base64'))])
  const stored: StoredDeviceKey = {
    v: 1,
    machine_id: machineId,
    label: cleanLabel(label),
    public_key: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    private_key: sealed.toString('base64'),
    created_at: new Date(deps.now()).toISOString(),
  }
  deps.setSetting(BRIDGE_DEVICE_SETTING, JSON.stringify(stored))
  log.info('bridge device key made', { fingerprint: keyFingerprint(stored.public_key) })
  return info(stored)
}

export function setDeviceLabel(label: string, deps: DeviceKeyDeps = defaultDeviceKeyDeps): DeviceKeyInfo {
  const stored = readStored(deps)
  if (!stored) throw new Error('This computer is not enrolled.')
  const next = { ...stored, label: cleanLabel(label) }
  deps.setSetting(BRIDGE_DEVICE_SETTING, JSON.stringify(next))
  return info(next)
}

/** Deletes the local key. The relay still lists the device until the operator revokes it. */
export function removeDeviceKey(deps: DeviceKeyDeps = defaultDeviceKeyDeps): void {
  if (!deps.getSetting(BRIDGE_DEVICE_SETTING)) return
  deps.removeSetting(BRIDGE_DEVICE_SETTING)
  log.info('bridge device key removed')
}

/**
 * Decrypts the private key into a signer. Throws `key_unreadable` when the
 * keychain is unavailable or the blob does not open (another computer's
 * keychain, a corrupt row), never with the key in the message.
 */
export function loadDeviceSigner(deps: DeviceKeyDeps = defaultDeviceKeyDeps): DeviceSigner | null {
  const stored = readStored(deps)
  if (!stored) return null
  const blob = Buffer.from(stored.private_key, 'base64')
  if (blob.length <= ENC_MAGIC.length || !blob.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC))
    throw new DeviceKeyError('key_unreadable', 'The stored device key is not keychain encrypted.')
  const safeStorage = deps.safeStorage()
  if (!safeStorage?.isEncryptionAvailable())
    throw new DeviceKeyError('key_unreadable', 'The keychain is not available, so the device key cannot be read.')
  let key: KeyObject
  try {
    const der = Buffer.from(safeStorage.decryptString(blob.subarray(ENC_MAGIC.length)), 'base64')
    key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  } catch (err) {
    log.warn('the bridge device key did not decrypt', err instanceof Error ? err.name : 'unknown')
    throw new DeviceKeyError('key_unreadable', 'The device key cannot be decrypted on this computer.')
  }
  return {
    machineId: stored.machine_id,
    sign: (text) => sign('sha256', Buffer.from(text, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }).toString('base64'),
  }
}
