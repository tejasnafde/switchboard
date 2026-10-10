/**
 * Picked-photo to SEND_TURN payload conversion.
 */
import { describe, it, expect } from 'vitest'
import { inferMimeType, resizeSourceType, totalWireBytes, MAX_TURN_WIRE_BYTES } from '../../apps/mobile/src/lib/images'

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

describe('resizeSourceType', () => {
  it('keeps a type the resize path distinguishes', () => {
    expect(resizeSourceType({ uri: 'file:///a.png', mimeType: 'image/png' })).toBe('image/png')
    expect(resizeSourceType({ uri: 'file:///a.gif' })).toBe('image/gif')
  })

  it('treats an image type we cannot send as is (HEIC) as a photo, since it is re-encoded', () => {
    expect(resizeSourceType({ uri: 'file:///a.heic', mimeType: 'image/heic' })).toBe('image/jpeg')
  })

  it('refuses bytes that are not labeled as an image', () => {
    expect(resizeSourceType({ uri: 'file:///a.heic', mimeType: 'application/octet-stream' })).toBeNull()
    expect(resizeSourceType({ uri: 'content://media/external/images/1' })).toBeNull()
  })
})

describe('totalWireBytes', () => {
  it('sums the encoded data URLs', () => {
    expect(totalWireBytes([{ url: 'abc' }, { url: 'de' }])).toBe(5)
    expect(MAX_TURN_WIRE_BYTES).toBe(3 * 1024 * 1024)
  })
})
