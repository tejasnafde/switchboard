/**
 * Passphrase-based AES-256-GCM for at-rest secrets on a headless backend,
 * where Electron's safeStorage (OS keychain) isn't available. The key is
 * derived from a passphrase (the SWITCHBOARD_SECRET env var on the VM) via
 * scrypt with a per-blob random salt.
 *
 * Blob layout: [16 salt][12 iv][16 gcm tag][ciphertext].
 */
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'

const SALT_LEN = 16
const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32

export function seal(plaintext: string, passphrase: string): Buffer {
  const salt = randomBytes(SALT_LEN)
  const key = scryptSync(passphrase, salt, KEY_LEN)
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([salt, iv, cipher.getAuthTag(), ct])
}

export function unseal(blob: Buffer, passphrase: string): string {
  const salt = blob.subarray(0, SALT_LEN)
  const iv = blob.subarray(SALT_LEN, SALT_LEN + IV_LEN)
  const tag = blob.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN)
  const ct = blob.subarray(SALT_LEN + IV_LEN + TAG_LEN)
  const key = scryptSync(passphrase, salt, KEY_LEN)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}
