/**
 * Google Cloud IAP TCP-forwarding relay: URL building + subprotocol framing.
 *
 * Why this exists: every GeoIQ VM is reached through
 * `gcloud compute start-iap-tunnel` (see ~/.ssh/config ProxyCommands), never a
 * routable SSH port. IAP is a WebSocket relay at tunnel.cloudproxy.app over
 * 443, so a phone holding a Google OAuth access token can reach a VM port from
 * ANY network, with no laptop and no VPN. The relay forwards an arbitrary port,
 * so we tunnel straight to the Switchboard backend rather than to sshd.
 *
 * Wire format mirrored from the gcloud SDK
 * (googlecloudsdk/api_lib/compute/iap_tunnel_websocket_utils.py):
 *   frame = uint16 tag, then a tag-specific body
 *     0x0001 CONNECT_SUCCESS_SID     uint32 len + bytes (session id)
 *     0x0002 RECONNECT_SUCCESS_ACK   uint64 ack
 *     0x0004 DATA                    uint32 len + bytes
 *     0x0007 ACK                     uint64 total bytes received
 * All integers big-endian. Pure module: no network, no platform APIs.
 */

export const IAP_URL_HOST = 'tunnel.cloudproxy.app'
export const IAP_SUBPROTOCOL = 'relay.tunnel.cloudproxy.app'
/** The relay rejects DATA frames larger than this. */
export const IAP_MAX_DATA_FRAME = 16384

export const IAP_TAG = {
  CONNECT_SUCCESS_SID: 0x0001,
  RECONNECT_SUCCESS_ACK: 0x0002,
  DATA: 0x0004,
  ACK: 0x0007,
} as const

export interface IapTarget {
  project: string
  zone: string
  instance: string
  /** VM port to forward to (the Switchboard backend, not 22). */
  port: number
  /** Defaults to nic0, matching gcloud. */
  networkInterface?: string
}

/** wss URL for a fresh tunnel. Query order matches gcloud for parity. */
export function iapConnectUrl(target: IapTarget): string {
  const q = new URLSearchParams({
    project: target.project,
    port: String(target.port),
    newWebsocket: 'True',
    zone: target.zone,
    instance: target.instance,
    interface: target.networkInterface ?? 'nic0',
  })
  return `wss://${IAP_URL_HOST}/v4/connect?${q.toString()}`
}

/** wss URL that resumes a dropped tunnel from `ackBytes` (sid from CONNECT_SUCCESS_SID). */
export function iapReconnectUrl(target: IapTarget, sid: string, ackBytes: number): string {
  const q = new URLSearchParams({
    project: target.project,
    port: String(target.port),
    newWebsocket: 'True',
    zone: target.zone,
    instance: target.instance,
    interface: target.networkInterface ?? 'nic0',
    sid,
    ack: String(ackBytes),
  })
  return `wss://${IAP_URL_HOST}/v4/reconnect?${q.toString()}`
}

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, false)
}

/** DATA frame: tag + uint32 length + payload. Caller must chunk to IAP_MAX_DATA_FRAME. */
export function encodeIapData(payload: Uint8Array): Uint8Array {
  if (payload.length > IAP_MAX_DATA_FRAME) {
    throw new Error(`IAP data frame too large: ${payload.length} > ${IAP_MAX_DATA_FRAME}`)
  }
  const out = new Uint8Array(6 + payload.length)
  const view = new DataView(out.buffer)
  writeUint16(view, 0, IAP_TAG.DATA)
  view.setUint32(2, payload.length, false)
  out.set(payload, 6)
  return out
}

/** ACK frame: tag + uint64 total-bytes-received. Uses BigInt for the 64-bit field. */
export function encodeIapAck(totalBytes: number): Uint8Array {
  const out = new Uint8Array(10)
  const view = new DataView(out.buffer)
  writeUint16(view, 0, IAP_TAG.ACK)
  view.setBigUint64(2, BigInt(totalBytes), false)
  return out
}

/** Split a payload into relay-legal DATA-sized chunks. */
export function chunkForIap(payload: Uint8Array): Uint8Array[] {
  if (payload.length <= IAP_MAX_DATA_FRAME) return [payload]
  const chunks: Uint8Array[] = []
  for (let i = 0; i < payload.length; i += IAP_MAX_DATA_FRAME) {
    chunks.push(payload.subarray(i, i + IAP_MAX_DATA_FRAME))
  }
  return chunks
}

export type IapFrame =
  | { kind: 'connectSuccess'; sid: string }
  | { kind: 'reconnectAck'; ack: number }
  | { kind: 'data'; payload: Uint8Array }
  | { kind: 'ack'; ack: number }
  | { kind: 'unknown'; tag: number }

/**
 * Incremental parser: relay messages can split mid-frame, so unconsumed bytes
 * are buffered until the next push. Feed every WebSocket binary message in
 * order and drain the returned frames.
 */
export class IapFrameParser {
  private buf = new Uint8Array(0)

  push(chunk: Uint8Array): IapFrame[] {
    if (this.buf.length > 0) {
      const merged = new Uint8Array(this.buf.length + chunk.length)
      merged.set(this.buf, 0)
      merged.set(chunk, this.buf.length)
      this.buf = merged
    } else {
      this.buf = chunk
    }

    const frames: IapFrame[] = []
    for (;;) {
      const parsed = this.parseOne(this.buf)
      if (!parsed) break
      frames.push(parsed.frame)
      this.buf = this.buf.subarray(parsed.consumed)
    }
    return frames
  }

  /** Returns null when the buffer holds an incomplete frame (wait for more). */
  private parseOne(buf: Uint8Array): { frame: IapFrame; consumed: number } | null {
    if (buf.length < 2) return null
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const tag = view.getUint16(0, false)

    switch (tag) {
      case IAP_TAG.DATA:
      case IAP_TAG.CONNECT_SUCCESS_SID: {
        if (buf.length < 6) return null
        const len = view.getUint32(2, false)
        if (buf.length < 6 + len) return null
        const body = buf.subarray(6, 6 + len)
        const frame: IapFrame =
          tag === IAP_TAG.DATA
            ? { kind: 'data', payload: new Uint8Array(body) }
            : { kind: 'connectSuccess', sid: new TextDecoder().decode(body) }
        return { frame, consumed: 6 + len }
      }
      case IAP_TAG.ACK:
      case IAP_TAG.RECONNECT_SUCCESS_ACK: {
        if (buf.length < 10) return null
        const ack = Number(view.getBigUint64(2, false))
        return {
          frame: tag === IAP_TAG.ACK ? { kind: 'ack', ack } : { kind: 'reconnectAck', ack },
          consumed: 10,
        }
      }
      default:
        // Unknown tags carry no length we can trust, so the stream is no longer
        // parseable - report and let the caller tear the tunnel down.
        return { frame: { kind: 'unknown', tag }, consumed: buf.length }
    }
  }
}
