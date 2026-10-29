import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acpFsProblem, sliceTextLines } from '../../src/main/provider/adapters/acp/fs-access'

describe('acpFsProblem', () => {
  it('refuses a write in plan mode and allows it in the other modes', () => {
    expect(acpFsProblem('write', '/repo/a.ts', 'plan')).toMatch(/Plan mode/)
    expect(acpFsProblem('write', '/repo/a.ts', 'sandbox')).toBeNull()
    expect(acpFsProblem('write', '/repo/a.ts', 'full-access')).toBeNull()
  })

  it('lets plan mode read', () => {
    expect(acpFsProblem('read', '/repo/a.ts', 'plan')).toBeNull()
  })

  it('refuses a relative path and a request with no live session', () => {
    expect(acpFsProblem('read', 'a.ts', 'sandbox')).toMatch(/absolute/)
    expect(acpFsProblem('write', '/repo/a.ts', undefined)).toMatch(/No active session/)
  })
})

describe('acpFsProblem and the secrets folder', () => {
  it('refuses a write under the secrets folder, also through a symlink, and lets a read through', () => {
    const base = mkdtempSync(join(tmpdir(), 'sb-acp-secrets-'))
    try {
      const secrets = join(base, 'secrets')
      mkdirSync(join(secrets, 'abc'), { recursive: true })
      symlinkSync(secrets, join(base, 'link'))
      expect(acpFsProblem('write', join(secrets, 'abc', 'KEY_A'), 'full-access', secrets)).toMatch(/secrets/)
      expect(acpFsProblem('write', join(secrets, 'new', 'KEY_A'), 'full-access', secrets)).toMatch(/secrets/)
      expect(acpFsProblem('write', join(base, 'link', 'abc', 'KEY_A'), 'full-access', secrets)).toMatch(/secrets/)
      expect(acpFsProblem('write', join(base, 'repo', '..', 'secrets', 'x'), 'full-access', secrets)).toMatch(/secrets/)
      expect(acpFsProblem('read', join(secrets, 'abc', 'KEY_A'), 'full-access', secrets)).toBeNull()
      expect(acpFsProblem('write', join(base, 'secrets-other', 'a.ts'), 'full-access', secrets)).toBeNull()
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('sliceTextLines', () => {
  const text = 'one\ntwo\nthree\nfour'

  it('returns the whole file when neither line nor limit is given', () => {
    expect(sliceTextLines(text)).toBe(text)
    expect(sliceTextLines(text, null, null)).toBe(text)
  })

  it('reads from a 1-based line, unbounded without a limit', () => {
    expect(sliceTextLines(text, 3)).toBe('three\nfour')
  })

  it('caps the count with limit, from the first line by default', () => {
    expect(sliceTextLines(text, null, 2)).toBe('one\ntwo')
    expect(sliceTextLines(text, 2, 2)).toBe('two\nthree')
  })
})
