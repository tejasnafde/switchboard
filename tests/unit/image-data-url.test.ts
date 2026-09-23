import { describe, expect, it } from 'vitest'
import { parseImageDataUrl, validateUserMessageImages, USER_MESSAGE_IMAGE_TYPES } from '@shared/provider-events'

describe('parseImageDataUrl', () => {
  it('splits every accepted type, including image/svg+xml shaped MIME types', () => {
    for (const type of USER_MESSAGE_IMAGE_TYPES) {
      expect(parseImageDataUrl(`data:${type};base64,QUJD`)).toEqual({ mimeType: type, data: 'QUJD' })
    }
    expect(parseImageDataUrl('data:image/svg+xml;base64,QUJD')).toEqual({ mimeType: 'image/svg+xml', data: 'QUJD' })
  })
  it('returns null for anything that is not a base64 data URL', () => {
    expect(parseImageDataUrl('https://example.com/a.png')).toBeNull()
    expect(parseImageDataUrl('data:image/png,raw')).toBeNull()
  })
})

describe('validateUserMessageImages', () => {
  it('rejects an SVG with a clear message instead of dropping it later', () => {
    expect(() => validateUserMessageImages([{ url: 'data:image/svg+xml;base64,QUJD' }])).toThrow(/PNG, JPEG, WebP, or GIF/)
  })
  it('accepts a PNG', () => {
    expect(validateUserMessageImages([{ url: 'data:image/png;base64,QUJD' }])).toHaveLength(1)
  })
})
