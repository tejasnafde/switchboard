/**
 * The Bitbucket email + API token for Reviews, encrypted with Electron
 * safeStorage (the OS keychain) in its own file under userData. Not in the
 * settings table, so neither settings.json nor a generic `settings:get` can
 * reach it, and the token never goes back to the renderer: `status()` returns
 * the email only.
 *
 * The email and save time also sit in a plain `bitbucket.json` next to the
 * blob, so `status()` (read every time Settings opens) never decrypts. On an
 * unsigned build every decrypt can be a macOS keychain password prompt; the
 * token is decrypted only when a Bitbucket request is really made.
 *
 * A headless server has no safeStorage. Rather than write the token in
 * plaintext it reports `needs_desktop`, and saving is refused.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SafeStorage } from 'electron'
import type { BitbucketAccountState, BitbucketCredentialInput } from '@shared/pull-requests'
import { createMainLogger } from '../logger'
import { decryptCaller } from '../decrypt-caller'

const log = createMainLogger('pull-requests:credentials')

export const BITBUCKET_CREDENTIAL_FILE = join('source-control', 'bitbucket.bin')
export const BITBUCKET_METADATA_FILE = join('source-control', 'bitbucket.json')

interface BitbucketMetadata {
  email: string
  savedAt: number
}

type Crypto = Pick<SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>

export class CredentialStoreError extends Error {}

export function validateBitbucketInput(input: unknown): BitbucketCredentialInput {
  const value = input as Partial<BitbucketCredentialInput> | null
  const email = typeof value?.email === 'string' ? value.email.trim() : ''
  const apiToken = typeof value?.apiToken === 'string' ? value.apiToken.trim() : ''
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new CredentialStoreError('Enter the email of your Atlassian account.')
  if (apiToken.length < 8 || /\s/.test(apiToken)) throw new CredentialStoreError('Paste the whole API token.')
  return { email, apiToken }
}

export class BitbucketCredentialStore {
  private cached: BitbucketCredentialInput | null | undefined

  constructor(
    private readonly userDataRoot: () => string,
    private readonly crypto: () => Crypto | null,
  ) {}

  private get file(): string {
    return join(this.userDataRoot(), BITBUCKET_CREDENTIAL_FILE)
  }

  private get metaFile(): string {
    return join(this.userDataRoot(), BITBUCKET_METADATA_FILE)
  }

  private readMeta(): BitbucketMetadata | null {
    if (!existsSync(this.metaFile)) return null
    try {
      const parsed = JSON.parse(readFileSync(this.metaFile, 'utf8')) as Partial<BitbucketMetadata>
      if (typeof parsed.email === 'string') return { email: parsed.email, savedAt: Number(parsed.savedAt) || 0 }
      log.warn('Bitbucket metadata has no email')
    } catch (err) {
      log.warn('Bitbucket metadata could not be read', { message: err instanceof Error ? err.message : String(err) })
    }
    return null
  }

  private metaJson(email: string): string {
    const meta: BitbucketMetadata = { email, savedAt: Date.now() }
    return JSON.stringify(meta)
  }

  private writeMeta(email: string): void {
    const tmp = `${this.metaFile}.tmp`
    writeFileSync(tmp, this.metaJson(email), { mode: 0o600 })
    renameSync(tmp, this.metaFile)
  }

  private usable(): Crypto | null {
    const c = this.crypto()
    return c && c.isEncryptionAvailable() ? c : null
  }

  read(): BitbucketCredentialInput | null {
    if (this.cached !== undefined) return this.cached
    const crypto = this.usable()
    if (!crypto || !existsSync(this.file)) {
      this.cached = null
      return null
    }
    try {
      log.debug('decrypting the Bitbucket token', { caller: decryptCaller() })
      const parsed = JSON.parse(crypto.decryptString(readFileSync(this.file))) as BitbucketCredentialInput
      this.cached = typeof parsed.email === 'string' && typeof parsed.apiToken === 'string' ? parsed : null
    } catch (err) {
      // Never log the error payload beyond its message: a partial decrypt could hold the token.
      log.warn('stored Bitbucket credentials could not be read', { message: err instanceof Error ? err.name : 'error' })
      this.cached = null
    }
    return this.cached
  }

  /**
   * Never decrypts, except once for a file saved before the metadata existed.
   * Also skips `isEncryptionAvailable()`, which on macOS can itself reach the
   * keychain; a machine without a keyring learns so when it saves.
   */
  status(): BitbucketAccountState {
    if (!this.crypto()) return { state: 'needs_desktop' }
    const meta = this.readMeta()
    if (meta && existsSync(this.file)) return { state: 'configured', email: meta.email }
    if (!existsSync(this.file)) return { state: 'unconfigured' }
    const creds = this.read()
    if (!creds) return { state: 'unconfigured' }
    try {
      this.writeMeta(creds.email)
    } catch (err) {
      log.warn('writing Bitbucket metadata failed', { message: err instanceof Error ? err.message : String(err) })
    }
    return { state: 'configured', email: creds.email }
  }

  /**
   * Replaces the token blob and the metadata together. Both go to temp files
   * first; if any write or rename fails, the previous files (raw bytes, never
   * decrypted) are put back, the in-memory credentials stay as they were, and
   * the save reports failure.
   */
  save(input: BitbucketCredentialInput): void {
    const crypto = this.usable()
    if (!crypto) throw new CredentialStoreError('Bitbucket needs the desktop app in this release.')
    const writes = [
      { path: this.file, data: crypto.encryptString(JSON.stringify(input)) },
      { path: this.metaFile, data: Buffer.from(this.metaJson(input.email)) },
    ].map((w) => ({ ...w, tmp: `${w.path}.tmp`, previous: fileBytesOrNull(w.path) }))
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      for (const w of writes) writeFileSync(w.tmp, w.data, { mode: 0o600 })
      for (const w of writes) renameSync(w.tmp, w.path)
    } catch (err) {
      log.error('saving Bitbucket credentials failed; restoring the previous files', { message: err instanceof Error ? err.message : String(err) })
      for (const w of writes) restoreFile(w.path, w.tmp, w.previous)
      throw new CredentialStoreError('Saving the Bitbucket account failed; the previous one is unchanged.')
    }
    this.cached = input
    log.info('Bitbucket credentials saved')
  }

  remove(): void {
    rmSync(this.file, { force: true })
    rmSync(this.metaFile, { force: true })
    this.cached = null
    log.info('Bitbucket credentials removed')
  }
}

function fileBytesOrNull(path: string): Buffer | null {
  try {
    return statSync(path).isFile() ? readFileSync(path) : null
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    // Unknown prior contents: abort the save, or a rollback would delete a file it could not restore.
    log.warn('could not snapshot a Bitbucket file before saving', { path, message: err instanceof Error ? err.message : String(err) })
    throw new CredentialStoreError('Saving the Bitbucket account failed; the previous one is unchanged.')
  }
}

function restoreFile(path: string, tmp: string, previous: Buffer | null): void {
  try {
    rmSync(tmp, { force: true })
  } catch (err) {
    log.warn('could not remove a Bitbucket temp file', { tmp, message: err instanceof Error ? err.message : String(err) })
  }
  try {
    if (previous) writeFileSync(path, previous, { mode: 0o600 })
    else rmSync(path, { force: true })
  } catch (err) {
    log.error('could not restore a Bitbucket file after a failed save', { path, message: err instanceof Error ? err.message : String(err) })
  }
}
