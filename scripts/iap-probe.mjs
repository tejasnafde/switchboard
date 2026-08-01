/**
 * One-shot probe: open a real IAP TCP-forwarding tunnel and read the first
 * bytes the far-side port sends. Proves the relay URL, the subprotocol framing,
 * and IAM (roles/iap.tunnelResourceAccessor) without gcloud in the loop.
 *
 * Usage:
 *   node scripts/iap-probe.mjs <project> <zone> <instance> <port> <accessToken>
 *
 * Port 22 is the best smoke target: sshd sends a banner unprompted, so a
 * successful tunnel prints "SSH-2.0-..." immediately.
 */
import WebSocket from 'ws'

const [project, zone, instance, portArg, token] = process.argv.slice(2)
if (!project || !zone || !instance || !portArg || !token) {
  console.error('usage: node scripts/iap-probe.mjs <project> <zone> <instance> <port> <accessToken>')
  process.exit(2)
}

const TAG = { CONNECT_SUCCESS_SID: 0x0001, RECONNECT_SUCCESS_ACK: 0x0002, DATA: 0x0004, ACK: 0x0007 }

const q = new URLSearchParams({
  project,
  port: portArg,
  newWebsocket: 'True',
  zone,
  instance,
  interface: 'nic0',
})
const url = `wss://tunnel.cloudproxy.app/v4/connect?${q}`

// Origin is load-bearing: without `bot:iap-tunneler` the relay completes the
// handshake and then sends nothing at all (gcloud's TUNNEL_CLOUDPROXY_ORIGIN).
const ws = new WebSocket(url, ['relay.tunnel.cloudproxy.app'], {
  headers: {
    'User-Agent': 'switchboard-iap-probe/1',
    Origin: 'bot:iap-tunneler',
    Authorization: `Bearer ${token}`,
  },
})

let buf = Buffer.alloc(0)
const timer = setTimeout(() => {
  console.error('TIMEOUT: no readable frame within 15s')
  ws.close()
  process.exit(1)
}, 15_000)

ws.on('unexpected-response', (_req, res) => {
  console.error(`HTTP ${res.statusCode} from relay (auth/IAM/scope problem)`)
  process.exit(1)
})
ws.on('error', (err) => {
  console.error('WS error:', err.message)
  process.exit(1)
})
ws.on('open', () => console.log('relay handshake OK (subprotocol accepted)'))

ws.on('message', (data) => {
  buf = Buffer.concat([buf, Buffer.from(data)])
  for (;;) {
    if (buf.length < 2) return
    const tag = buf.readUInt16BE(0)
    if (tag === TAG.DATA || tag === TAG.CONNECT_SUCCESS_SID) {
      if (buf.length < 6) return
      const len = buf.readUInt32BE(2)
      if (buf.length < 6 + len) return
      const body = buf.subarray(6, 6 + len)
      buf = buf.subarray(6 + len)
      if (tag === TAG.CONNECT_SUCCESS_SID) {
        console.log(`CONNECT_SUCCESS_SID (session established, sid ${body.length} bytes)`)
      } else {
        console.log(`DATA ${body.length} bytes: ${JSON.stringify(body.toString('utf8').slice(0, 80))}`)
        console.log('TUNNEL WORKS: bytes flowed from the VM port')
        clearTimeout(timer)
        ws.close()
        process.exit(0)
      }
    } else if (tag === TAG.ACK || tag === TAG.RECONNECT_SUCCESS_ACK) {
      if (buf.length < 10) return
      buf = buf.subarray(10)
    } else {
      console.error(`unknown tag 0x${tag.toString(16)}`)
      process.exit(1)
    }
  }
})
