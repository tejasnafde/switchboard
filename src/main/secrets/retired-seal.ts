/**
 * Seals a retired secret's value for `agent_secret_retired`: Electron
 * safeStorage (the OS keychain) on the desktop, the `SWITCHBOARD_SECRET`
 * passphrase on a headless backend. With neither there is no seal, and the
 * value is never written in plaintext: it then masks history until the
 * process ends.
 */
import { getSafeStorage } from '../runtime'
import { seal, unseal } from '../crypto/secret-box'
import { createMainLogger } from '../logger'

const log = createMainLogger('secrets:retired')

// The same sentinels as provider instance env blobs.
const ENC_MAGIC = Buffer.from([0x00, 0x53, 0x42, 0x45])
const PASS_MAGIC = Buffer.from([0x00, 0x53, 0x42, 0x50])

/** The sealed value, or null when nothing on this host can seal it. */
export function sealRetired(value: Buffer): Buffer | null {
  const text = value.toString('base64')
  const safeStorage = getSafeStorage()
  if (safeStorage?.isEncryptionAvailable()) return Buffer.concat([ENC_MAGIC, safeStorage.encryptString(text)])
  const passphrase = process.env.SWITCHBOARD_SECRET
  if (passphrase) return Buffer.concat([PASS_MAGIC, seal(text, passphrase)])
  return null
}

/** The value, or null (logged) when this host cannot open the blob. */
export function openRetired(blob: Buffer): Buffer | null {
  const body = blob.subarray(ENC_MAGIC.length)
  try {
    if (blob.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)) {
      const safeStorage = getSafeStorage()
      if (safeStorage?.isEncryptionAvailable()) return Buffer.from(safeStorage.decryptString(body), 'base64')
    } else if (blob.subarray(0, PASS_MAGIC.length).equals(PASS_MAGIC)) {
      const passphrase = process.env.SWITCHBOARD_SECRET
      if (passphrase) return Buffer.from(unseal(body, passphrase), 'base64')
    }
  } catch (err) {
    log.warn('could not open a retired secret', err instanceof Error ? err.name : 'unknown')
    return null
  }
  log.warn('a retired secret is sealed by a key this host does not have')
  return null
}
