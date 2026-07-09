/**
 * seedBridgeExtension copies the bundled sb-bridge extension into code-server's
 * --extensions-dir. Gotcha (verified in live probe): a stale extensions.json in
 * that dir marks unknown folders as removed, so the seeder must clear it.
 * Tests run against real tmp directories - pure I/O, no mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { seedBridgeExtension, BRIDGE_EXTENSION_DIRNAME } from '../../src/main/ide/code-server-manager'

describe('seedBridgeExtension', () => {
  let root: string
  let bundledDir: string
  let extensionsDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sb-ide-seed-'))
    bundledDir = join(root, 'bundled', 'sb-bridge')
    extensionsDir = join(root, 'extensions')
    mkdirSync(bundledDir, { recursive: true })
    writeFileSync(join(bundledDir, 'package.json'), '{"name":"sb-bridge","version":"0.0.1"}')
    writeFileSync(join(bundledDir, 'extension.js'), '// glue')
    writeFileSync(join(bundledDir, 'protocol.js'), '// pure')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('copies the bundled extension into the conventionally-named folder, creating the dir', () => {
    seedBridgeExtension(bundledDir, extensionsDir)
    const dest = join(extensionsDir, BRIDGE_EXTENSION_DIRNAME)
    expect(readFileSync(join(dest, 'package.json'), 'utf8')).toContain('sb-bridge')
    expect(existsSync(join(dest, 'extension.js'))).toBe(true)
    expect(existsSync(join(dest, 'protocol.js'))).toBe(true)
  })

  it('removes a stale extensions.json so the seeded folder is not marked as removed', () => {
    mkdirSync(extensionsDir, { recursive: true })
    writeFileSync(join(extensionsDir, 'extensions.json'), '[{"identifier":{"id":"other"}}]')
    writeFileSync(join(extensionsDir, '.obsolete'), '{}')
    seedBridgeExtension(bundledDir, extensionsDir)
    expect(existsSync(join(extensionsDir, 'extensions.json'))).toBe(false)
    expect(existsSync(join(extensionsDir, '.obsolete'))).toBe(false)
  })

  it('is idempotent and refreshes stale file contents on re-run', () => {
    seedBridgeExtension(bundledDir, extensionsDir)
    writeFileSync(join(bundledDir, 'extension.js'), '// updated glue')
    seedBridgeExtension(bundledDir, extensionsDir)
    expect(readFileSync(join(extensionsDir, BRIDGE_EXTENSION_DIRNAME, 'extension.js'), 'utf8')).toBe('// updated glue')
  })

  it('does not delete other installed extension folders', () => {
    const other = join(extensionsDir, 'someone.other-ext-1.0.0')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'package.json'), '{}')
    seedBridgeExtension(bundledDir, extensionsDir)
    expect(existsSync(join(other, 'package.json'))).toBe(true)
  })
})
