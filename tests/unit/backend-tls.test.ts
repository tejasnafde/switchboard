/** The phone endpoint's certificate and the port that serves ws:// and wss://. */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivateKey, X509Certificate } from 'node:crypto'
import { createServer, connect as connectTcp, type AddressInfo, type Socket } from 'node:net'
import { connect as connectTls } from 'node:tls'
import { Transform } from 'node:stream'
import type { TLSSocket } from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { DualWebSocketServer, loadOrCreateTlsIdentity } from '../../src/main/backend/tls'
import { WsHost } from '../../src/main/backend/ws-host'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sb-tls-test-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe('loadOrCreateTlsIdentity', () => {
  it('mints a valid self-signed certificate and reuses it across restarts', () => {
    const dir = scratch()
    const first = loadOrCreateTlsIdentity(dir)
    const cert = new X509Certificate(first.cert)
    expect(cert.verify(cert.publicKey)).toBe(true)
    expect(cert.fingerprint256.replace(/:/g, '').toLowerCase()).toBe(first.fingerprint)
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(new Date(cert.validTo).getUTCFullYear()).toBe(2099)
    if (process.platform !== 'win32') expect(statSync(join(dir, 'tls-key.pem')).mode & 0o777).toBe(0o600)

    expect(loadOrCreateTlsIdentity(dir)).toEqual(first)
  })

  it('always mints a certificate that parses (random serials)', () => {
    // A serial whose first byte is 0x00 before a byte < 0x80 is invalid DER, about 1 in 512.
    for (let i = 0; i < 1500; i++) {
      const dir = scratch()
      expect(() => loadOrCreateTlsIdentity(dir)).not.toThrow()
    }
  })

  it('replaces a certificate it cannot parse', () => {
    const dir = scratch()
    const first = loadOrCreateTlsIdentity(dir)
    writeFileSync(join(dir, 'tls-cert.pem'), 'garbage')
    const second = loadOrCreateTlsIdentity(dir)
    expect(second.fingerprint).not.toBe(first.fingerprint)
    expect(readFileSync(join(dir, 'tls-cert.pem'), 'utf8')).toBe(second.cert)
  })

  it('replaces a pair whose key is unreadable or belongs to another certificate', () => {
    const dir = scratch()
    const first = loadOrCreateTlsIdentity(dir)
    writeFileSync(join(dir, 'tls-key.pem'), 'garbage')
    const second = loadOrCreateTlsIdentity(dir)
    expect(second.fingerprint).not.toBe(first.fingerprint)

    const other = loadOrCreateTlsIdentity(scratch())
    writeFileSync(join(dir, 'tls-key.pem'), other.key)
    const third = loadOrCreateTlsIdentity(dir)
    expect(third.fingerprint).not.toBe(second.fingerprint)
    expect(new X509Certificate(third.cert).checkPrivateKey(createPrivateKey(third.key))).toBe(true)
  })
})

describe('DualWebSocketServer', () => {
  function boot(): Promise<{ port: number; fingerprint: string }> {
    const identity = loadOrCreateTlsIdentity(scratch())
    const wss = new DualWebSocketServer(0, '127.0.0.1', identity)
    cleanups.push(() => new Promise<void>((done) => wss.close(() => done())))
    const host = new WsHost(wss)
    cleanups.push(() => host.dispose())
    host.handle('echo', (value: unknown) => value)
    return new Promise((resolve) =>
      wss.on('listening', () =>
        resolve({ port: (wss.address() as AddressInfo).port, fingerprint: identity.fingerprint }),
      ),
    )
  }

  function call(url: string): Promise<{ reply: unknown; peerFingerprint: string | null }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { rejectUnauthorized: false })
      cleanups.push(() => ws.terminate())
      ws.on('error', reject)
      ws.on('open', () => ws.send(JSON.stringify({ k: 'req', id: 1, ch: 'echo', args: ['hi'] })))
      ws.on('message', (raw) => {
        const frame = JSON.parse(String(raw))
        if (frame.k !== 'res') return
        const tls = (ws as unknown as { _socket: TLSSocket })._socket
        const peer = typeof tls.getPeerX509Certificate === 'function' ? tls.getPeerX509Certificate() : undefined
        resolve({
          reply: frame.result ?? frame,
          peerFingerprint: peer ? peer.fingerprint256.replace(/:/g, '').toLowerCase() : null,
        })
      })
    })
  }

  it('answers ws:// and wss:// on one port, presenting the pinned certificate over TLS', async () => {
    const { port, fingerprint } = await boot()
    const plain = await call(`ws://127.0.0.1:${port}/`)
    expect(JSON.stringify(plain.reply)).toContain('hi')
    expect(plain.peerFingerprint).toBeNull()
    const secure = await call(`wss://127.0.0.1:${port}/`)
    expect(JSON.stringify(secure.reply)).toContain('hi')
    expect(secure.peerFingerprint).toBe(fingerprint)
  })

  it.each(['TLSv1.2', 'TLSv1.3'] as const)(
    'accepts a ClientHello split after its first byte with %s',
    async (version) => {
      const { port, fingerprint } = await boot()
      const sockets = new Set<Socket>()
      const proxy = createServer((client) => {
        const upstream = connectTcp(port, '127.0.0.1')
        sockets.add(client)
        sockets.add(upstream)
        let first = true
        const split = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            if (!first) return done(null, chunk)
            first = false
            this.push(chunk.subarray(0, 1))
            // Let the production listener route the first byte before the rest arrives.
            setTimeout(() => done(null, chunk.subarray(1)), 50)
          },
        })
        client.pipe(split).pipe(upstream).pipe(client)
      })
      cleanups.push(() => {
        for (const socket of sockets) socket.destroy()
        return new Promise<void>((done) => proxy.close(() => done()))
      })
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
      await new Promise<void>((resolve, reject) => {
        const socket = connectTls({
          port: (proxy.address() as AddressInfo).port,
          host: '127.0.0.1',
          rejectUnauthorized: false,
          minVersion: version,
          maxVersion: version,
        })
        cleanups.push(() => {
          socket.destroy()
        })
        socket.once('error', reject)
        socket.once('secureConnect', () => {
          try {
            expect(socket.getPeerX509Certificate()?.fingerprint256.replace(/:/g, '').toLowerCase()).toBe(fingerprint)
            resolve()
          } catch (err) {
            reject(err)
          }
        })
      })
    },
  )

  it('releases the port on close so the endpoint can restart on it', async () => {
    const identity = loadOrCreateTlsIdentity(scratch())
    const first = new DualWebSocketServer(0, '127.0.0.1', identity)
    await new Promise((r) => first.on('listening', r))
    const port = (first.address() as AddressInfo).port
    first.close()
    const second = new DualWebSocketServer(port, '127.0.0.1', identity)
    cleanups.push(() => new Promise<void>((done) => second.close(() => done())))
    await new Promise<void>((resolve, reject) => {
      second.on('listening', () => resolve())
      second.on('error', reject)
    })
  })
})
