/**
 * IAP relay framing, checked against the byte layout in the gcloud SDK
 * (iap_tunnel_websocket_utils.py): big-endian uint16 tag, uint32-prefixed
 * bodies for DATA/CONNECT_SUCCESS_SID, uint64 for ACK/RECONNECT_SUCCESS_ACK.
 * Split-message handling matters most: the relay does not respect frame
 * boundaries, so a half-frame must buffer rather than corrupt the stream.
 */
import { describe, it, expect } from 'vitest'
import {
  IapFrameParser,
  encodeIapData,
  encodeIapAck,
  chunkForIap,
  iapConnectUrl,
  iapReconnectUrl,
  IAP_MAX_DATA_FRAME,
  IAP_TAG,
} from '../../src/shared/iap-tunnel'

const target = {
  project: 'prj-geoiq-decisioniq-in-prod',
  zone: 'asia-south1-b',
  instance: 'geoiq-ssg-dev-in',
  port: 8765,
}

describe('IAP url building', () => {
  it('builds a connect url with the port we forward (not 22)', () => {
    const url = iapConnectUrl(target)
    expect(url.startsWith('wss://tunnel.cloudproxy.app/v4/connect?')).toBe(true)
    expect(url).toContain('project=prj-geoiq-decisioniq-in-prod')
    expect(url).toContain('port=8765')
    expect(url).toContain('instance=geoiq-ssg-dev-in')
    expect(url).toContain('zone=asia-south1-b')
    expect(url).toContain('interface=nic0')
    expect(url).toContain('newWebsocket=True')
  })

  it('reconnect url carries sid and ack', () => {
    const url = iapReconnectUrl(target, 'sid-abc', 4096)
    expect(url).toContain('/v4/reconnect?')
    expect(url).toContain('sid=sid-abc')
    expect(url).toContain('ack=4096')
  })
})

describe('IAP frame encoding', () => {
  it('DATA is tag + uint32 length + payload', () => {
    const frame = encodeIapData(new Uint8Array([1, 2, 3]))
    expect(frame.length).toBe(9)
    const view = new DataView(frame.buffer)
    expect(view.getUint16(0, false)).toBe(IAP_TAG.DATA)
    expect(view.getUint32(2, false)).toBe(3)
    expect([...frame.subarray(6)]).toEqual([1, 2, 3])
  })

  it('ACK is tag + uint64 total', () => {
    const frame = encodeIapAck(70000)
    expect(frame.length).toBe(10)
    const view = new DataView(frame.buffer)
    expect(view.getUint16(0, false)).toBe(IAP_TAG.ACK)
    expect(Number(view.getBigUint64(2, false))).toBe(70000)
  })

  it('refuses an oversized DATA frame', () => {
    expect(() => encodeIapData(new Uint8Array(IAP_MAX_DATA_FRAME + 1))).toThrow(/too large/)
  })

  it('chunks payloads to the relay limit', () => {
    const chunks = chunkForIap(new Uint8Array(IAP_MAX_DATA_FRAME * 2 + 5))
    expect(chunks.map((c) => c.length)).toEqual([IAP_MAX_DATA_FRAME, IAP_MAX_DATA_FRAME, 5])
    expect(chunkForIap(new Uint8Array(10))).toHaveLength(1)
  })
})

describe('IapFrameParser', () => {
  it('parses a connect-success sid', () => {
    const sid = 'session-xyz'
    const body = new TextEncoder().encode(sid)
    const buf = new Uint8Array(6 + body.length)
    const view = new DataView(buf.buffer)
    view.setUint16(0, IAP_TAG.CONNECT_SUCCESS_SID, false)
    view.setUint32(2, body.length, false)
    buf.set(body, 6)

    expect(new IapFrameParser().push(buf)).toEqual([{ kind: 'connectSuccess', sid }])
  })

  it('round-trips a DATA frame', () => {
    const payload = new TextEncoder().encode('{"k":"req","id":1}')
    const frames = new IapFrameParser().push(encodeIapData(payload))
    expect(frames).toHaveLength(1)
    expect(frames[0].kind).toBe('data')
    if (frames[0].kind === 'data') {
      expect(new TextDecoder().decode(frames[0].payload)).toBe('{"k":"req","id":1}')
    }
  })

  it('buffers a frame split across relay messages', () => {
    const full = encodeIapData(new TextEncoder().encode('hello world'))
    const parser = new IapFrameParser()
    // Split mid-header and mid-payload: neither half is parseable alone.
    expect(parser.push(full.subarray(0, 3))).toEqual([])
    expect(parser.push(full.subarray(3, 8))).toEqual([])
    const frames = parser.push(full.subarray(8))
    expect(frames).toHaveLength(1)
    if (frames[0].kind === 'data') {
      expect(new TextDecoder().decode(frames[0].payload)).toBe('hello world')
    }
  })

  it('parses several frames arriving in one message', () => {
    const a = encodeIapData(new Uint8Array([0xaa]))
    const b = encodeIapAck(99)
    const c = encodeIapData(new Uint8Array([0xbb]))
    const merged = new Uint8Array(a.length + b.length + c.length)
    merged.set(a, 0)
    merged.set(b, a.length)
    merged.set(c, a.length + b.length)

    const frames = new IapFrameParser().push(merged)
    expect(frames.map((f) => f.kind)).toEqual(['data', 'ack', 'data'])
    expect(frames[1]).toEqual({ kind: 'ack', ack: 99 })
  })

  it('reports an unknown tag instead of silently desyncing', () => {
    const buf = new Uint8Array([0x00, 0x63, 0x00])
    expect(new IapFrameParser().push(buf)).toEqual([{ kind: 'unknown', tag: 0x63 }])
  })

  it('a large payload survives chunk + reassemble', () => {
    const original = new Uint8Array(IAP_MAX_DATA_FRAME + 1234).map((_, i) => i % 251)
    const parser = new IapFrameParser()
    const out: number[] = []
    for (const chunk of chunkForIap(original)) {
      for (const frame of parser.push(encodeIapData(chunk))) {
        if (frame.kind === 'data') out.push(...frame.payload)
      }
    }
    expect(out).toEqual([...original])
  })
})
