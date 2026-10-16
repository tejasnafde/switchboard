/** Native Apple interoperability coverage, using the production server and identity. */
import { execFile, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DualWebSocketServer, loadOrCreateTlsIdentity } from '../../src/main/backend/tls'

const exec = promisify(execFile)

// swiftc ships with Apple's command-line tools, a separate install, so a Mac
// without them skips this file. CI's macOS leg sets SB_REQUIRE_SWIFTC=1 so the
// coverage cannot skip silently there.
const hasSwiftc = process.platform === 'darwin' && spawnSync('swiftc', ['--version']).status === 0
if (process.env.SB_REQUIRE_SWIFTC === '1' && !hasSwiftc)
  throw new Error('SB_REQUIRE_SWIFTC=1 but swiftc is not available')

describe.skipIf(!hasSwiftc)('Apple URLSession against DualWebSocketServer', () => {
  let dir: string
  let server: DualWebSocketServer
  let port: number
  let fingerprint: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sb-appletls.'))
    await exec('swiftc', [resolve('tests/fixtures/apple-tls-probe.swift'), '-o', join(dir, 'probe')], {
      timeout: 60_000,
    })
    const identity = loadOrCreateTlsIdentity(join(dir, 'identity'))
    // A restart must present exactly the certificate that was originally paired.
    expect(loadOrCreateTlsIdentity(join(dir, 'identity'))).toEqual(identity)
    fingerprint = identity.fingerprint
    server = new DualWebSocketServer(0, '127.0.0.1', identity)
    server.on('connection', (ws) => ws.on('message', (data) => ws.send(data)))
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
    port = (server.address() as AddressInfo).port
  }, 65_000)

  afterAll(async () => {
    if (server) {
      for (const ws of server.clients) ws.terminate()
      await new Promise<void>((done) => server.close(() => done()))
    }
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it.each(['default', 'tls12'])(
    'accepts the paired certificate with %s TLS',
    async (mode) => {
      const { stdout } = await exec(join(dir, 'probe'), [`wss://127.0.0.1:${port}`, fingerprint, mode], {
        timeout: 15_000,
      })
      expect(stdout).toContain('TRUST CALLBACK match=true')
      expect(stdout).toContain('OPEN')
      expect(stdout).toContain('ECHO')
    },
    20_000,
  )

  it('rejects a different pin in the trust callback', async () => {
    const { stdout } = await exec(join(dir, 'probe'), [`wss://127.0.0.1:${port}`, '0'.repeat(64), 'mismatch'], {
      timeout: 15_000,
    })
    expect(stdout).toContain('TRUST CALLBACK match=false')
    expect(stdout).not.toContain('OPEN')
    expect(stdout).not.toContain('ECHO')
  }, 20_000)
})
