import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>
}

describe('native rebuild script', () => {
  it('rebuilds every native module used by the desktop app', () => {
    expect(pkg.scripts.rebuild).toContain('node-pty')
    expect(pkg.scripts.rebuild).toContain('better-sqlite3')
  })
})
