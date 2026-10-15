/**
 * TLS for the phone endpoint: one self-signed certificate per install, and a
 * listener that serves wss:// and ws:// on the SAME port.
 *
 * The phone pins the certificate's SHA-256 fingerprint, which the pairing QR
 * carries (`fp`), so no CA is involved and the certificate never needs to name
 * the host. Sharing the port keeps every saved address valid: a phone that does
 * not know `fp` keeps dialling ws:// where it always did.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { createMainLogger as createLogger } from '../logger'
import { wsServerOptions } from './ws-host'

const log = createLogger('backend:tls')

export interface TlsIdentity {
  key: string
  cert: string
  /** SHA-256 of the certificate's DER, lowercase hex: what the phone pins. */
  fingerprint: string
}

export function certificateFingerprint(certPem: string): string {
  return createHash('sha256').update(new X509Certificate(certPem).raw).digest('hex')
}

/**
 * Load the install's certificate from `dir`, creating it on first use. A new
 * certificate means every pinned phone must pair again, so an unreadable pair
 * is replaced only when it cannot be parsed, never on a read race.
 */
export function loadOrCreateTlsIdentity(dir: string): TlsIdentity {
  const keyFile = join(dir, 'tls-key.pem')
  const certFile = join(dir, 'tls-cert.pem')
  if (existsSync(keyFile) && existsSync(certFile)) {
    const key = readFileSync(keyFile, 'utf8')
    const cert = readFileSync(certFile, 'utf8')
    try {
      return { key, cert, fingerprint: certificateFingerprint(cert) }
    } catch (err) {
      log.warn('stored TLS certificate is unreadable, minting a new one (paired phones must pair again)', err)
    }
  }
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const cert = selfSignedCertificate(publicKey.export({ type: 'spki', format: 'der' }), (tbs) =>
    sign('sha256', tbs, privateKey),
  )
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  mkdirSync(dir, { recursive: true })
  writeFileSync(keyFile, key, { mode: 0o600 })
  writeFileSync(certFile, cert)
  log.info('minted a TLS certificate for the phone endpoint')
  return { key, cert, fingerprint: certificateFingerprint(cert) }
}

// ── Minimal DER, enough for one X.509 v3 certificate ──
// Hand-rolled because Node can parse certificates but not create
// them; swap for a library if this ever needs extensions or other key types.

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  const n = body.length
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff])
  return Buffer.concat([Buffer.from([tag]), len, body])
}
const seq = (...parts: Buffer[]): Buffer => der(0x30, ...parts)
function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number)
  const bytes = [a * 40 + b]
  for (const v of rest) {
    const chunk = [v & 0x7f]
    for (let x = v >> 7; x > 0; x >>= 7) chunk.unshift((x & 0x7f) | 0x80)
    bytes.push(...chunk)
  }
  return der(0x06, Buffer.from(bytes))
}
const time = (d: Date): Buffer => {
  // UTCTime through 2049, GeneralizedTime after (RFC 5280 4.1.2.5).
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'
  return d.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(iso.slice(2))) : der(0x18, Buffer.from(iso))
}

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'))

function selfSignedCertificate(spki: Buffer, signer: (tbs: Buffer) => Buffer): string {
  const name = seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from('Switchboard')))))
  const serial = randomBytes(16)
  serial[0] &= 0x7f // positive INTEGER
  const notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))), // v3
    der(0x02, serial),
    ECDSA_SHA256,
    name,
    // The pin is the trust anchor, so the certificate does not expire in any
    // way that matters; a dated one would strand every phone on the day.
    seq(time(notBefore), time(new Date(Date.UTC(2099, 11, 31, 23, 59, 59)))),
    name,
    spki,
  )
  const signature = der(0x03, Buffer.from([0]), signer(tbs))
  const body = seq(tbs, ECDSA_SHA256, signature).toString('base64')
  return `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`
}

// ── One port, both schemes ──

/** A client that connects and never speaks is dropped after this. */
const SNIFF_TIMEOUT_MS = 10_000
const TLS_HANDSHAKE_RECORD = 0x16

function upgradeRequired(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(426, { 'Content-Type': 'text/plain' })
  res.end('Upgrade Required')
}

/**
 * A WebSocketServer listening on `port` that accepts both ws:// and wss://.
 * The first byte decides: a TLS ClientHello starts with a handshake record,
 * an HTTP upgrade with a letter. `close()` also stops the shared listener.
 */
export class DualWebSocketServer extends WebSocketServer {
  private readonly front: NetServer

  constructor(port: number, host: string, identity: TlsIdentity) {
    const plain = createHttpServer(upgradeRequired)
    const secure = createHttpsServer({ key: identity.key, cert: identity.cert }, upgradeRequired)
    const { port: _port, host: _host, ...options } = wsServerOptions(port, host)
    super({ ...options, server: plain })
    // ws listens for upgrades, 'listening' and 'error' on `plain`, so both
    // listeners funnel there.
    secure.on('upgrade', (req, socket, head) => plain.emit('upgrade', req, socket, head))
    secure.on('tlsClientError', (err) => log.debug('TLS handshake failed', err.message))
    const front = createNetServer((socket) => route(socket, plain, secure))
    front.on('listening', () => plain.emit('listening'))
    front.on('error', (err) => plain.emit('error', err))
    front.listen(port, host)
    this.front = front
  }

  override address(): ReturnType<NetServer['address']> {
    return this.front.address()
  }

  override close(cb?: (err?: Error) => void): void {
    // Synchronous, so a restart on the same port does not race the old bind.
    this.front.close()
    super.close(cb)
  }
}

function route(socket: Socket, plain: NetServer, secure: NetServer): void {
  const onError = (err: Error): void => log.debug('phone socket failed before routing', err.message)
  socket.on('error', onError)
  socket.setTimeout(SNIFF_TIMEOUT_MS, () => socket.destroy())
  socket.once('readable', function sniff() {
    const first: Buffer | null = socket.read(1)
    if (first === null) {
      if (socket.readableEnded) return
      socket.once('readable', sniff)
      return
    }
    socket.unshift(first)
    socket.setTimeout(0)
    socket.off('error', onError)
    ;(first[0] === TLS_HANDSHAKE_RECORD ? secure : plain).emit('connection', socket)
  })
}
