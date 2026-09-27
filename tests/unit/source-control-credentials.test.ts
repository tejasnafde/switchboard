/**
 * The Bitbucket credential store: encrypted with safeStorage in its own file,
 * never plaintext, never in settings.json, and refused outright on a backend
 * with no keychain.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/main/logger', () => ({ createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))

import { BITBUCKET_CREDENTIAL_FILE, BITBUCKET_METADATA_FILE, BitbucketCredentialStore, CredentialStoreError, validateBitbucketInput } from '../../src/main/pull-requests/credentials'
import { FILE_SETTINGS } from '../../src/shared/settings-file'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sb-scm-creds-'))
  dirs.push(d)
  return d
}

// Reversible stand-in for the keychain: enough to prove the file is not plaintext.
const fakeCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s, 'utf8').map((b) => b ^ 0x5a),
  decryptString: (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8'),
}

const creds = { email: 'me@example.com', apiToken: 'ATATT3xFfGF0-secret' }

describe('BitbucketCredentialStore', () => {
  it('stores the token encrypted and reports only the email', () => {
    const root = tempDir()
    const store = new BitbucketCredentialStore(() => root, () => fakeCrypto)
    expect(store.status()).toEqual({ state: 'unconfigured' })
    store.save(creds)
    const onDisk = readFileSync(join(root, BITBUCKET_CREDENTIAL_FILE))
    expect(onDisk.toString('utf8')).not.toContain('ATATT')
    expect(onDisk.toString('utf8')).not.toContain('me@example.com')
    expect(store.status()).toEqual({ state: 'configured', email: 'me@example.com' })
    expect(JSON.stringify(store.status())).not.toContain('ATATT')
    // A fresh store (a relaunch) reads it back.
    expect(new BitbucketCredentialStore(() => root, () => fakeCrypto).read()).toEqual(creds)
  })

  it('removes the file', () => {
    const root = tempDir()
    const store = new BitbucketCredentialStore(() => root, () => fakeCrypto)
    store.save(creds)
    store.remove()
    expect(existsSync(join(root, BITBUCKET_CREDENTIAL_FILE))).toBe(false)
    expect(existsSync(join(root, BITBUCKET_METADATA_FILE))).toBe(false)
    expect(store.status()).toEqual({ state: 'unconfigured' })
  })

  it('refuses to store anything without safeStorage, rather than writing plaintext', () => {
    const root = tempDir()
    const headless = new BitbucketCredentialStore(() => root, () => null)
    expect(headless.status()).toEqual({ state: 'needs_desktop' })
    expect(() => headless.save(creds)).toThrow('Bitbucket needs the desktop app in this release.')
    expect(existsSync(join(root, BITBUCKET_CREDENTIAL_FILE))).toBe(false)

    const noKeyring = new BitbucketCredentialStore(() => root, () => ({ ...fakeCrypto, isEncryptionAvailable: () => false }))
    expect(() => noKeyring.save(creds)).toThrow()
  })

  it('treats an unreadable file as no credentials when a request needs them', () => {
    const root = tempDir()
    new BitbucketCredentialStore(() => root, () => fakeCrypto).save(creds)
    const broken = new BitbucketCredentialStore(() => root, () => ({ ...fakeCrypto, decryptString: () => { throw new Error('bad key') } }))
    expect(broken.read()).toBeNull()
  })

  it('status never decrypts, even in a fresh process', () => {
    const root = tempDir()
    new BitbucketCredentialStore(() => root, () => fakeCrypto).save(creds)
    const decryptString = vi.fn(fakeCrypto.decryptString)
    const isEncryptionAvailable = vi.fn(() => true)
    const relaunched = new BitbucketCredentialStore(() => root, () => ({ ...fakeCrypto, decryptString, isEncryptionAvailable }))
    expect(relaunched.status()).toEqual({ state: 'configured', email: 'me@example.com' })
    expect(relaunched.status()).toEqual({ state: 'configured', email: 'me@example.com' })
    expect(decryptString).not.toHaveBeenCalled()
    expect(isEncryptionAvailable).not.toHaveBeenCalled()
    expect(readFileSync(join(root, BITBUCKET_METADATA_FILE), 'utf8')).not.toContain('ATATT')
    expect(relaunched.read()).toEqual(creds)
    expect(decryptString).toHaveBeenCalledTimes(1)
  })

  it('decrypts a file saved before the metadata existed once, then never for status', () => {
    const root = tempDir()
    new BitbucketCredentialStore(() => root, () => fakeCrypto).save(creds)
    rmSync(join(root, BITBUCKET_METADATA_FILE))
    const decryptString = vi.fn(fakeCrypto.decryptString)
    const crypto = () => ({ ...fakeCrypto, decryptString })
    expect(new BitbucketCredentialStore(() => root, crypto).status()).toEqual({ state: 'configured', email: 'me@example.com' })
    expect(new BitbucketCredentialStore(() => root, crypto).status()).toEqual({ state: 'configured', email: 'me@example.com' })
    expect(decryptString).toHaveBeenCalledTimes(1)
  })
})

describe('validateBitbucketInput', () => {
  it('trims and checks the shape', () => {
    expect(validateBitbucketInput({ email: ' me@example.com ', apiToken: ' tok-12345678 ' })).toEqual({ email: 'me@example.com', apiToken: 'tok-12345678' })
    expect(() => validateBitbucketInput({ email: 'nope', apiToken: 'tok-12345678' })).toThrow('email')
    expect(() => validateBitbucketInput({ email: 'me@example.com', apiToken: 'short' })).toThrow('token')
    expect(() => validateBitbucketInput(null)).toThrow()
  })
})

describe('settings.json', () => {
  it('has no source control or Bitbucket key on its allow-list', () => {
    for (const s of FILE_SETTINGS) expect(s.key).not.toMatch(/bitbucket|source-?control|github|token/i)
  })

  describe('a save that fails part way leaves the previous account in place', () => {
    const next = { email: 'new@example.com', apiToken: 'ATATT-new' }

    function savedStore() {
      const root = tempDir()
      const store = new BitbucketCredentialStore(() => root, () => fakeCrypto)
      store.save(creds)
      const blob = readFileSync(join(root, BITBUCKET_CREDENTIAL_FILE))
      const meta = readFileSync(join(root, BITBUCKET_METADATA_FILE))
      return { root, store, blob, meta }
    }

    function expectUnchanged(root: string, store: BitbucketCredentialStore, blob: Buffer, meta: Buffer) {
      expect(readFileSync(join(root, BITBUCKET_CREDENTIAL_FILE))).toEqual(blob)
      expect(readFileSync(join(root, BITBUCKET_METADATA_FILE))).toEqual(meta)
      expect(existsSync(join(root, `${BITBUCKET_CREDENTIAL_FILE}.tmp`))).toBe(false)
      expect(store.read()).toEqual(creds)
      expect(store.status()).toEqual({ state: 'configured', email: 'me@example.com' })
      expect(new BitbucketCredentialStore(() => root, () => fakeCrypto).read()).toEqual(creds)
    }

    it('when the metadata temp file cannot be written', () => {
      const { root, store, blob, meta } = savedStore()
      mkdirSync(join(root, `${BITBUCKET_METADATA_FILE}.tmp`))
      expect(() => store.save(next)).toThrow(CredentialStoreError)
      expectUnchanged(root, store, blob, meta)
    })

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses to save, and deletes nothing, when an existing file cannot be read', () => {
      const { root, store } = savedStore()
      const file = join(root, BITBUCKET_CREDENTIAL_FILE)
      chmodSync(file, 0o000)
      try {
        expect(() => store.save(next)).toThrow(CredentialStoreError)
        expect(existsSync(file)).toBe(true)
      } finally {
        chmodSync(file, 0o600)
      }
      expect(store.read()).toEqual(creds)
    })

    it('when the metadata rename fails after the token was already replaced', () => {
      const root = tempDir()
      const store = new BitbucketCredentialStore(() => root, () => fakeCrypto)
      store.save(creds)
      const blob = readFileSync(join(root, BITBUCKET_CREDENTIAL_FILE))
      rmSync(join(root, BITBUCKET_METADATA_FILE))
      // A non-empty directory where the metadata goes: its rename cannot succeed.
      mkdirSync(join(root, BITBUCKET_METADATA_FILE, 'x'), { recursive: true })
      expect(() => store.save(next)).toThrow(CredentialStoreError)
      expect(readFileSync(join(root, BITBUCKET_CREDENTIAL_FILE))).toEqual(blob)
      expect(existsSync(join(root, `${BITBUCKET_METADATA_FILE}.tmp`))).toBe(false)
      expect(store.read()).toEqual(creds)
    })
  })
})
