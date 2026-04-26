import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'

/**
 * We can't test PtyManager directly here (it requires node-pty compiled for
 * the host Node, not Electron), but we can test the shell resolution logic
 * extracted into a pure function.
 */

function resolveShell(requested?: string): string {
  const candidates = [
    requested,
    process.env.SHELL,
    '/bin/zsh',
    '/bin/bash',
    '/bin/sh',
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return '/bin/sh'
}

describe('resolveShell', () => {
  it('returns the requested shell if it exists', () => {
    expect(resolveShell('/bin/sh')).toBe('/bin/sh')
  })

  it('falls back to SHELL env if requested does not exist', () => {
    const result = resolveShell('/nonexistent/shell')
    expect(existsSync(result)).toBe(true)
  })

  it('falls through to /bin/zsh or /bin/bash on macOS/Linux', () => {
    const result = resolveShell(undefined)
    expect(result).toMatch(/\/(zsh|bash|sh)$/)
    expect(existsSync(result)).toBe(true)
  })

  it('never returns a non-existent path', () => {
    // Even with garbage env, should find /bin/sh at minimum
    const original = process.env.SHELL
    process.env.SHELL = '/nonexistent'
    try {
      const result = resolveShell('/also/nonexistent')
      expect(existsSync(result)).toBe(true)
    } finally {
      process.env.SHELL = original
    }
  })
})
