/**
 * The Bitbucket email + API token for Reviews, encrypted with Electron
 * safeStorage (the OS keychain) in its own file under userData. Not in the
 * settings table, so neither settings.json nor a generic `settings:get` can
 * reach it, and the token never goes back to the renderer: `status()` returns
 * the email only.
 *
 * A headless server has no safeStorage. Rather than write the token in
 * plaintext it reports `needs_desktop`, and saving is refused.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SafeStorage } from 'electron'
import type { BitbucketAccountState, BitbucketCredentialInput } from '@shared/pull-requests'
import { createMainLogger } from '../logger'

const log = createMainLogger('pull-requests:credentials')

export const BITBUCKET_CREDENTIAL_FILE = join('source-control', 'bitbucket.bin')

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
      const parsed = JSON.parse(crypto.decryptString(readFileSync(this.file))) as BitbucketCredentialInput
      this.cached = typeof parsed.email === 'string' && typeof parsed.apiToken === 'string' ? parsed : null
    } catch (err) {
      // Never log the error payload beyond its message: a partial decrypt could hold the token.
      log.warn('stored Bitbucket credentials could not be read', { message: err instanceof Error ? err.name : 'error' })
      this.cached = null
    }
    return this.cached
  }

  status(): BitbucketAccountState {
    if (!this.usable()) return { state: 'needs_desktop' }
    const creds = this.read()
    return creds ? { state: 'configured', email: creds.email } : { state: 'unconfigured' }
  }

  save(input: BitbucketCredentialInput): void {
    const crypto = this.usable()
    if (!crypto) throw new CredentialStoreError('Bitbucket needs the desktop app in this release.')
    const blob = crypto.encryptString(JSON.stringify(input))
    const file = this.file
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, blob, { mode: 0o600 })
    renameSync(tmp, file)
    this.cached = input
    log.info('Bitbucket credentials saved')
  }

  remove(): void {
    rmSync(this.file, { force: true })
    this.cached = null
    log.info('Bitbucket credentials removed')
  }
}
