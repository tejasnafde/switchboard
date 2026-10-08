/**
 * IapTransport resume: each tunnel is a new instance seeded with the previous
 * one's cursor, speaking the same hello/ready handshake as WsTransport. A host
 * that cannot replay must still work, and must make the owner re-seed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IapFrameParser, encodeIapData } from '@shared/iap-tunnel'
import { BACKEND_CAPABILITIES } from '@shared/ws-protocol'
import { IapTransport, type IapResumeState } from '../../apps/mobile/src/lib/iap-transport'

class FakeRelay {
  static last: FakeRelay
  readyState = 0
  binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  readonly sent: unknown[] = []
  private readonly parser = new IapFrameParser()

  constructor() {
    FakeRelay.last = this
  }

  send(buf: ArrayBuffer): void {
    for (const frame of this.parser.push(new Uint8Array(buf))) {
      if (frame.kind !== 'data') continue
      for (const line of new TextDecoder().decode(frame.payload).split('\n')) {
        if (line) this.sent.push(JSON.parse(line))
      }
    }
  }

  close(): void {
    this.onclose?.()
  }

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  /** Host -> phone, one NDJSON line. */
  line(frame: object): void {
    const bytes = encodeIapData(new TextEncoder().encode(JSON.stringify(frame) + '\n'))
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer })
  }
}

const NEW_HOST_CAPS = [...BACKEND_CAPABILITIES]
const OLD_HOST_CAPS = BACKEND_CAPABILITIES.filter((c) => c !== 'event_replay_v1')

function tunnel(resume?: IapResumeState, backendToken?: string) {
  const transport = new IapTransport({
    target: { project: 'p', zone: 'z', instance: 'vm', port: 8766 },
    accessToken: 'google',
    backendToken,
    resume,
  })
  const relay = FakeRelay.last
  const seen: unknown[] = []
  transport.on('provider:event', (e) => seen.push(e))
  const onGap = vi.fn()
  transport.onResumeGap = onGap
  relay.open()
  return { transport, relay, seen, onGap }
}

const evt = (seq: number | undefined, n: number) => ({ k: 'evt', ch: 'provider:event', args: [{ n }], seq })
const ready = (epoch: string, seq: number, gap = false, capabilities: string[] = NEW_HOST_CAPS) => ({
  k: 'ready',
  epoch,
  seq,
  replayed: 0,
  gap,
  capabilities,
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeRelay)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('IapTransport resume', () => {
  it('sends auth with resume, then hello with the carried cursor', () => {
    const { relay } = tunnel({ since: 7, epoch: 'e1' }, 's3cret')
    expect(relay.sent.slice(0, 2)).toEqual([
      { k: 'auth', token: 's3cret', resume: true },
      { k: 'hello', since: 7, epoch: 'e1' },
    ])
  })

  it('drop and reconnect: applies the replay in order, skipping what was already seen', () => {
    const a = tunnel()
    a.relay.line(ready('e1', 0))
    a.relay.line(evt(1, 1))
    a.relay.line(evt(2, 2))
    a.relay.close()
    expect(a.transport.isAlive()).toBe(false)

    const b = tunnel(a.transport.resumeState())
    expect(b.relay.sent[0]).toEqual({ k: 'hello', since: 2, epoch: 'e1' })
    // A live frame beats the replay onto the wire; it must still land last.
    b.relay.line(evt(4, 4))
    b.relay.line(evt(2, 2))
    b.relay.line(evt(3, 3))
    expect(b.seen).toEqual([])
    b.relay.line(ready('e1', 4))
    expect(b.seen).toEqual([{ n: 3 }, { n: 4 }])
    expect(b.onGap).not.toHaveBeenCalled()
    expect(b.transport.resumeState()).toEqual({ since: 4, epoch: 'e1' })
  })

  it('takes the first ready as the baseline, keeping events held before it', () => {
    const a = tunnel()
    a.relay.line(evt(51, 51))
    a.relay.line(ready('e1', 50))
    expect(a.transport.resumeState()).toEqual({ since: 51, epoch: 'e1' })
    expect(a.seen).toEqual([{ n: 51 }])

    const idle = tunnel()
    idle.relay.line(ready('e1', 50))
    expect(idle.transport.resumeState()).toEqual({ since: 50, epoch: 'e1' })
  })

  it('probes a capable host and keeps an answered tunnel alive', () => {
    const a = tunnel()
    a.relay.line(ready('e1', 0))
    a.transport.probe()
    expect(a.relay.sent.some((frame) => (frame as { k?: string }).k === 'ping')).toBe(true)
    a.relay.line({ k: 'pong', t: 1 })
    vi.advanceTimersByTime(3_000)
    expect(a.transport.isAlive()).toBe(true)
  })

  it('reconnects only after a proven heartbeat probe fails', () => {
    const a = tunnel()
    a.relay.line(ready('e1', 0))
    const reconnect = vi.fn()
    a.transport.onReconnectNeeded = reconnect
    a.transport.probe()
    vi.advanceTimersByTime(3_000)
    expect(a.transport.isAlive()).toBe(false)
    expect(reconnect).toHaveBeenCalledOnce()
  })

  it('hands an older TCP host that cannot answer probes to connect() instead of killing it', () => {
    const a = tunnel()
    const reconnect = vi.fn()
    a.transport.onReconnectNeeded = reconnect
    a.relay.line(
      ready(
        'e1',
        0,
        false,
        NEW_HOST_CAPS.filter((capability) => capability !== 'heartbeat_v1'),
      ),
    )
    a.transport.probe()
    vi.advanceTimersByTime(3_000)
    expect(a.transport.isAlive()).toBe(true)
    expect(reconnect).toHaveBeenCalledOnce()
  })

  it('re-seeds when the host reports a gap', () => {
    const b = tunnel({ since: 2, epoch: 'e1' })
    b.relay.line(ready('e1', 900, true))
    expect(b.onGap).toHaveBeenCalledOnce()
    b.relay.line(evt(901, 1))
    expect(b.seen).toEqual([{ n: 1 }])
  })

  it('re-seeds when the host restarted, even with nothing seen before', () => {
    const b = tunnel({ since: 0, epoch: 'e1' })
    b.relay.line(ready('e2', 0))
    expect(b.onGap).toHaveBeenCalledOnce()
  })

  it('a first connect is never a gap', () => {
    const a = tunnel()
    a.relay.line(ready('e1', 50, false, OLD_HOST_CAPS))
    expect(a.onGap).not.toHaveBeenCalled()
  })

  it('old host without replay: re-seeds once per reconnect, events still flow', () => {
    const b = tunnel({ since: 0, epoch: 'e1' }, 's3cret')
    // It sends ready after auth AND after hello.
    b.relay.line(ready('e1', 0, false, OLD_HOST_CAPS))
    b.relay.line(ready('e1', 0, false, OLD_HOST_CAPS))
    b.relay.line(evt(undefined, 1))
    expect(b.onGap).toHaveBeenCalledOnce()
    expect(b.seen).toEqual([{ n: 1 }])
  })

  it('host that never answers hello: events flow, and a resume re-seeds after the timeout', () => {
    const b = tunnel({ since: 0, epoch: null })
    b.relay.line(evt(undefined, 1))
    expect(b.seen).toEqual([{ n: 1 }])
    expect(b.onGap).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10_000)
    expect(b.onGap).toHaveBeenCalledOnce()

    const first = tunnel()
    vi.advanceTimersByTime(10_000)
    expect(first.onGap).not.toHaveBeenCalled()
  })
})
