/**
 * The bridge device key on a real migrated database with a safeStorage fake:
 * the private key round trips only encrypted, enrollment is refused without
 * a keychain, an unreadable key is reported and never logged, and a row an
 * older run stored is read back and signs.
 */
import { createPublicKey, verify } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMigratedDb } from './helpers/test-db'

const logged: unknown[] = []
vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => {
    const record = (...args: unknown[]) => void logged.push(args)
    return { debug: record, info: record, warn: record, error: record }
  },
}))

import { getSetting, setSetting } from '../../src/main/db/database'
import {
  BRIDGE_DEVICE_SETTING,
  DeviceKeyError,
  defaultDeviceKeyDeps,
  enrollDeviceKey,
  keyFingerprint,
  loadDeviceSigner,
  readDeviceKey,
  removeDeviceKey,
  setDeviceLabel,
  type DeviceKeyDeps,
  type SafeStorageLike,
} from '../../src/main/bridge/device-key'
import { bridgeHelloPayload } from '../../src/shared/bridge'

/** Reversible, and visibly not plaintext: XOR over a `sealed:` prefix. */
function fakeSafeStorage(available = true): SafeStorageLike & { decrypts: number } {
  const xor = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a))
  return {
    decrypts: 0,
    isEncryptionAvailable: () => available,
    encryptString: (text) => xor(Buffer.from(`sealed:${text}`)),
    decryptString(blob) {
      this.decrypts += 1
      const text = xor(blob).toString()
      if (!text.startsWith('sealed:')) throw new Error('Error while decrypting the ciphertext provided')
      return text.slice('sealed:'.length)
    },
  }
}

function deps(storage: SafeStorageLike | null = fakeSafeStorage()): DeviceKeyDeps {
  return { ...defaultDeviceKeyDeps, safeStorage: () => storage, now: () => Date.parse('2026-11-06T12:00:00Z') }
}

function verifies(publicKey: string, text: string, signature: string): boolean {
  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
  return verify('sha256', Buffer.from(text), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64'))
}

/** A row exactly as a run of this build stored it (fake keychain above), kept to catch a format change. */
const OLDER_RUN_ROW =
  '{"v":1,"machine_id":"hub-0b6c3f0e-older-run","label":"Work Mac","public_key":"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEI4ulJUAfMQO1lNkGrWtVUcV7SfeBW/S03oEVXhS3QToeMD2vE1dNZuDzeaCTvsoRT2VaXgt9QFHkg7OOLy0skQ==","private_key":"AFNCRSk/OzY/PmAXEx0SGz0fGxcYFx0YIysdCRduYxs9Hx0ZGSsdCRduYxstHxIYHWotOy0TGBsLCz07ChUYCjIRMB1oNCAIKRESIzwZYy0LaSovICkxHz8uHBEgPgkzDzAUaBJsMggbFBkbGwswM2wPNgsYYiIbbQ0PaAs7LjtrDAgiAi4QY24cOGMWDj89CAw/HBY+GBUybi0KO2IODGprN24KFG81EBVxIzIcCgAMKj8ZaWsbDz8JHilubiwWCSMI","created_at":"2026-11-06T10:00:00.000Z"}'

beforeEach(() => {
  createMigratedDb()
  logged.length = 0
})

describe('bridge device key', () => {
  it('stores the private key only encrypted and signs the hello payload', () => {
    const storage = fakeSafeStorage()
    const info = enrollDeviceKey('hub-1', '  Work   Mac ', deps(storage))
    expect(info).toMatchObject({ machineId: 'hub-1', label: 'Work Mac', createdAt: '2026-11-06T12:00:00.000Z' })
    expect(info.fingerprint).toBe(keyFingerprint(info.publicKey))
    expect(info.fingerprint).toMatch(/^[0-9a-f]{16}$/)

    const row = JSON.parse(getSetting(BRIDGE_DEVICE_SETTING)!)
    const blob = Buffer.from(row.private_key, 'base64')
    expect([...blob.subarray(0, 4)]).toEqual([0x00, 0x53, 0x42, 0x45])
    expect(blob.toString('latin1')).not.toMatch(/MIG|sealed/)

    const signer = loadDeviceSigner(deps(storage))!
    const payload = bridgeHelloPayload({ origin: 'https://bridge.tn07.dev', machineId: 'hub-1', nonce: 'n'.repeat(43) })
    const signature = signer.sign(payload)
    expect(Buffer.from(signature, 'base64')).toHaveLength(64)
    expect(verifies(info.publicKey, payload, signature)).toBe(true)
    expect(verifies(info.publicKey, `${payload}x`, signature)).toBe(false)
  })

  it('makes the key once: enrolling again answers the same key', () => {
    const first = enrollDeviceKey('hub-1', 'Work Mac', deps())
    const second = enrollDeviceKey('hub-1', 'Other', deps())
    expect(second.publicKey).toBe(first.publicKey)
    expect(second.label).toBe('Work Mac')
    expect(setDeviceLabel('Desk', deps()).label).toBe('Desk')
    expect(readDeviceKey(deps())!.publicKey).toBe(first.publicKey)
  })

  it('refuses to make a key when the keychain cannot encrypt, and stores nothing', () => {
    for (const storage of [fakeSafeStorage(false), null]) {
      expect(() => enrollDeviceKey('hub-1', 'Work Mac', deps(storage))).toThrowError(
        expect.objectContaining({ code: 'encryption_unavailable' }),
      )
      expect(getSetting(BRIDGE_DEVICE_SETTING)).toBeNull()
    }
  })

  it('reports an unreadable key without its bytes in the error or the log', () => {
    enrollDeviceKey('hub-1', 'Work Mac', deps())
    const row = getSetting(BRIDGE_DEVICE_SETTING)!
    expect(() => loadDeviceSigner(deps(fakeSafeStorage(false)))).toThrow(DeviceKeyError)

    const parsed = JSON.parse(row)
    setSetting(
      BRIDGE_DEVICE_SETTING,
      JSON.stringify({ ...parsed, private_key: Buffer.from([0, 0x53, 0x42, 0x45, 1, 2, 3]).toString('base64') }),
    )
    expect(() => loadDeviceSigner(deps())).toThrowError(expect.objectContaining({ code: 'key_unreadable' }))

    // A plaintext key (no sentinel) is refused, not used.
    setSetting(
      BRIDGE_DEVICE_SETTING,
      JSON.stringify({ ...parsed, private_key: Buffer.from('plain').toString('base64') }),
    )
    expect(() => loadDeviceSigner(deps())).toThrowError(expect.objectContaining({ code: 'key_unreadable' }))

    const text = JSON.stringify(logged)
    expect(text).not.toContain(parsed.private_key)
    expect(text).not.toContain(parsed.public_key)
  })

  it('reads back and signs with a key an older run stored (upgrade path)', () => {
    setSetting(BRIDGE_DEVICE_SETTING, OLDER_RUN_ROW)
    const info = readDeviceKey(deps())!
    expect(info).toMatchObject({ machineId: 'hub-0b6c3f0e-older-run', label: 'Work Mac' })
    const signer = loadDeviceSigner(deps())!
    expect(signer.machineId).toBe('hub-0b6c3f0e-older-run')
    const payload = bridgeHelloPayload({ origin: 'https://bridge.tn07.dev', machineId: signer.machineId, nonce: 'abc' })
    expect(verifies(info.publicKey, payload, signer.sign(payload))).toBe(true)
  })

  it('removes the enrollment', () => {
    enrollDeviceKey('hub-1', 'Work Mac', deps())
    removeDeviceKey(deps())
    expect(readDeviceKey(deps())).toBeNull()
    expect(loadDeviceSigner(deps())).toBeNull()
  })

  it('never overwrites a row it cannot read (another version), until it is removed', () => {
    for (const row of ['{"v":2,"private_key":"x"}', 'not json']) {
      setSetting(BRIDGE_DEVICE_SETTING, row)
      expect(readDeviceKey(deps())).toBeNull()
      expect(() => enrollDeviceKey('hub-1', 'Work Mac', deps())).toThrowError(
        expect.objectContaining({ code: 'key_unreadable' }),
      )
      expect(getSetting(BRIDGE_DEVICE_SETTING)).toBe(row)
    }
    removeDeviceKey(deps())
    expect(enrollDeviceKey('hub-1', 'Work Mac', deps()).machineId).toBe('hub-1')
  })
})
