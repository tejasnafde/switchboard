/** Remote setup payload: the package.json + install script we drop on a VM. */
import { describe, it, expect } from 'vitest'
import { remotePackageJson, remoteInstallScript, REMOTE_SERVER_DIR } from '../../src/main/machines/provisionSetup'

describe('remotePackageJson', () => {
  const pkg = remotePackageJson('0.4.16', '12.9.0')

  it('stamps the app version and is private', () => {
    expect(pkg.version).toBe('0.4.16')
    expect(pkg.private).toBe(true)
  })

  it('pins better-sqlite3 to the app build version', () => {
    expect(pkg.dependencies['better-sqlite3']).toBe('12.9.0')
  })

  it('aliases node-pty to the multiarch fork (ships linux prebuilds)', () => {
    expect(pkg.dependencies['node-pty']).toMatch(/^npm:@homebridge\/node-pty-prebuilt-multiarch@/)
  })

  it('points main at the uploaded bundle', () => {
    expect(pkg.main).toBe('index.cjs')
  })
})

describe('remoteInstallScript', () => {
  const script = remoteInstallScript('0.4.16')

  it('creates the server dir and installs without dev deps or audit noise', () => {
    expect(script).toContain(REMOTE_SERVER_DIR)
    expect(script).toMatch(/npm install/)
    expect(script).toContain('--omit=dev')
  })

  it('writes the version marker last so a half-finished install never looks ready', () => {
    const installAt = script.indexOf('npm install')
    const markerAt = script.lastIndexOf('0.4.16')
    expect(installAt).toBeGreaterThan(-1)
    expect(markerAt).toBeGreaterThan(installAt)
  })

  it('chains steps with && so a failure aborts the rest', () => {
    expect(script).toContain('&&')
  })
})
