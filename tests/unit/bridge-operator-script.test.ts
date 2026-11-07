/**
 * `scripts/bridge-operator.mjs` runs its command only when node was given that
 * file. The guard compares realpaths: a run through a symlinked path (every
 * path under /var/folders on macOS, which is /private/var) used to compare
 * unequal, so the script did nothing and exited 0.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { isDirectRun, parsePublicKey } from '../../scripts/bridge-operator.mjs'

const SCRIPT = resolve(__dirname, '../../scripts/bridge-operator.mjs')
const SCRIPT_URL = pathToFileURL(SCRIPT).href
const dir = mkdtempSync(join(tmpdir(), 'sb-bridge-operator-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('bridge-operator entry guard', () => {
  it('runs when node was given this file through a symlinked path', () => {
    const link = join(dir, 'bridge-operator.mjs')
    symlinkSync(SCRIPT, link)
    expect(isDirectRun(SCRIPT_URL, SCRIPT)).toBe(true)
    expect(isDirectRun(SCRIPT_URL, link)).toBe(true)
  })

  it('does not run when it was imported, or when the entry is gone', () => {
    const other = join(dir, 'other.mjs')
    writeFileSync(other, '')
    expect(isDirectRun(SCRIPT_URL, other)).toBe(false)
    expect(isDirectRun(SCRIPT_URL, undefined)).toBe(false)
    expect(isDirectRun(SCRIPT_URL, join(dir, 'missing.mjs'))).toBe(false)
  })

  it('refuses a private key where a public one is expected', () => {
    expect(() => parsePublicKey('{"d":"secret","kty":"EC"}')).toThrow(/public key/)
    expect(() => parsePublicKey('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----')).toThrow(/public key/)
  })
})
