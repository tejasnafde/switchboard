/**
 * Picked-photo to SEND_TURN payload conversion.
 */
import { describe, it, expect } from 'vitest'
import {
  assetToPayload,
  inferMimeType,
  base64ByteLength,
  formatBytes,
  fitTurnBudget,
  totalWireBytes,
  MAX_IMAGE_BYTES,
  MAX_TURN_WIRE_BYTES,
} from '../../apps/mobile/src/lib/images'

describe('inferMimeType', () => {
  it('accepts a supported picker type', () => {
    expect(inferMimeType({ uri: 'file:///x.bin', mimeType: 'image/png' })).toBe('image/png')
  })

  it('canonicalizes the jpeg alias', () => {
    expect(inferMimeType({ uri: 'file:///x.bin', mimeType: 'image/jpg' })).toBe('image/jpeg')
    expect(inferMimeType({ uri: 'file:///a/b.jpg' })).toBe('image/jpeg')
  })

  it('falls back to the extension, case-insensitively', () => {
    expect(inferMimeType({ uri: 'file:///a/b.PNG' })).toBe('image/png')
    expect(inferMimeType({ uri: 'file:///a/b.webp' })).toBe('image/webp')
  })

  it('prefers fileName over uri when present', () => {
    expect(inferMimeType({ uri: 'content://media/1234', fileName: 'shot.png' })).toBe('image/png')
  })

  it('ignores a query string on the uri', () => {
    expect(inferMimeType({ uri: 'https://h/x.png?width=10' })).toBe('image/png')
  })

  it('rejects unsupported and unknown formats instead of relabeling their bytes', () => {
    expect(inferMimeType({ uri: 'file:///a/b.heic', mimeType: 'application/octet-stream' })).toBeNull()
    expect(inferMimeType({ uri: 'file:///a/b.bmp', mimeType: 'image/bmp' })).toBeNull()
    expect(inferMimeType({ uri: 'content://media/external/images/1' })).toBeNull()
  })
})

describe('base64ByteLength', () => {
  it('computes decoded length, discounting padding', () => {
    // "hello" -> aGVsbG8= : 5 bytes.
    expect(base64ByteLength('aGVsbG8=')).toBe(5)
    expect(base64ByteLength('AAAA')).toBe(3)
  })
})

describe('assetToPayload', () => {
  it('builds a data URL with the resolved mime type', () => {
    const result = assetToPayload({ uri: 'file:///a.png', base64: 'AAAA', mimeType: 'image/png' })
    expect(result).toEqual({
      ok: true,
      payload: { url: 'data:image/png;base64,AAAA', mimeType: 'image/png' },
    })
  })

  it('refuses an asset with no base64, since a file uri is useless to a remote backend', () => {
    expect(assetToPayload({ uri: 'file:///a.png' })).toEqual({ ok: false, reason: 'no-data' })
    expect(assetToPayload({ uri: 'file:///a.png', base64: null })).toEqual({ ok: false, reason: 'no-data' })
  })

  it('refuses a format the backend cannot synchronize', () => {
    expect(assetToPayload({ uri: 'file:///a.heic', base64: 'AAAA', mimeType: 'image/heic' })).toEqual({
      ok: false,
      reason: 'unsupported-type',
    })
  })

  it('refuses one image whose encoded data URL exceeds the turn cap', () => {
    const oversize = 'A'.repeat(MAX_TURN_WIRE_BYTES)
    expect(assetToPayload({ uri: 'file:///big.jpg', base64: oversize })).toEqual({
      ok: false,
      reason: 'too-large',
    })
  })

  it('accepts one image whose complete encoded data URL fits the turn cap', () => {
    const justUnder = 'A'.repeat(MAX_TURN_WIRE_BYTES - 'data:image/jpeg;base64,'.length)
    expect(assetToPayload({ uri: 'file:///ok.jpg', base64: justUnder }).ok).toBe(true)
  })

  it('exposes a decoded-byte ceiling consistent with the encoded wire budget', () => {
    expect(MAX_IMAGE_BYTES).toBe(Math.floor(MAX_TURN_WIRE_BYTES * 3 / 4))
  })
})

describe('formatBytes', () => {
  it('scales the unit', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})

describe('fitTurnBudget', () => {
  const img = (bytes: number) => ({ url: 'x'.repeat(bytes) })

  it('accepts everything that fits', () => {
    const { accepted, rejected } = fitTurnBudget([], [img(1000), img(2000)])
    expect(accepted).toHaveLength(2)
    expect(rejected).toHaveLength(0)
  })

  it('rejects the additions that would cross the total, keeping order', () => {
    const half = Math.floor(MAX_TURN_WIRE_BYTES / 2)
    const { accepted, rejected } = fitTurnBudget([], [img(half), img(half), img(half)])
    expect(accepted).toHaveLength(2)
    expect(rejected).toHaveLength(1)
  })

  it('counts what is already attached', () => {
    // The frame cap is enforced by dropping the connection, so the budget has to
    // account for images picked in an earlier tap.
    const nearlyFull = MAX_TURN_WIRE_BYTES - 100
    const { accepted, rejected } = fitTurnBudget([img(nearlyFull)], [img(500)])
    expect(accepted).toHaveLength(0)
    expect(rejected).toHaveLength(1)
  })

  it('skips an oversized item but still takes a later small one', () => {
    const { accepted } = fitTurnBudget([], [img(MAX_TURN_WIRE_BYTES + 1), img(10)])
    expect(accepted).toHaveLength(1)
    expect(accepted[0].url).toHaveLength(10)
  })

  it('accepts more than four images when their combined wire payload fits', () => {
    const existing = [img(1), img(1), img(1)]
    const { accepted, rejected } = fitTurnBudget(existing, [img(1), img(1), img(1)])
    expect(accepted).toHaveLength(3)
    expect(rejected).toHaveLength(0)
  })

  it('measures wire cost as the data URL length', () => {
    expect(totalWireBytes([{ url: 'abc' }, { url: 'de' }])).toBe(5)
    expect(totalWireBytes([])).toBe(0)
  })
})
