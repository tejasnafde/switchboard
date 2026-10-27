/**
 * Every image a provider gets is at most MAX_IMAGE_LONG_SIDE on its long
 * side: the Claude API refuses larger ones once a request holds more than 20
 * images, which breaks every later turn of a long chat.
 */
import { describe, expect, it } from 'vitest'
import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js'
import { PNG } from 'pngjs'
import { JPEG_STEPS, MAX_IMAGE_LONG_SIDE, imageTypeOf, resizeAttempts, sendAsIs } from '../../src/shared/image-resize'
import { fitImagesToProviderLimit, imageDimensions } from '../../src/main/provider/image-limits'

function png(width: number, height: number): Buffer {
  const image = new PNG({ width, height })
  image.data.fill(200)
  return PNG.sync.write(image)
}

function jpeg(width: number, height: number): Buffer {
  return encodeJpeg({ data: Buffer.alloc(width * height * 4, 120), width, height }, 80).data
}

const dataUrl = (mimeType: string, bytes: Buffer) => `data:${mimeType};base64,${bytes.toString('base64')}`

function gifHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(13)
  bytes.write('GIF89a')
  bytes.writeUInt16LE(width, 6)
  bytes.writeUInt16LE(height, 8)
  return bytes
}

function webpVp8xHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30)
  bytes.write('RIFF')
  bytes.write('WEBPVP8X', 8)
  bytes.writeUIntLE(width - 1, 24, 3)
  bytes.writeUIntLE(height - 1, 27, 3)
  return bytes
}

describe('client resize steps', () => {
  it('never start above the provider limit', () => {
    expect(MAX_IMAGE_LONG_SIDE).toBe(2000)
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      for (const attempt of resizeAttempts(type) ?? []) expect(attempt.maxSide).toBeLessThanOrEqual(2000)
    }
    expect(JPEG_STEPS[0].maxSide).toBe(2000)
  })

  it('refuse a GIF over the limit, which is sent unchanged', () => {
    expect(sendAsIs(100, 1000, 2048)).toBe('gif-too-wide')
    expect(sendAsIs(100, 1000, 2000)).toBe('ok')
  })
})

describe('imageDimensions', () => {
  it('reads PNG, JPEG, GIF and WebP headers', () => {
    expect(imageDimensions(png(30, 20))).toEqual({ width: 30, height: 20 })
    expect(imageDimensions(jpeg(40, 10))).toEqual({ width: 40, height: 10 })
    expect(imageDimensions(gifHeader(2048, 5))).toEqual({ width: 2048, height: 5 })
    expect(imageDimensions(webpVp8xHeader(3000, 7))).toEqual({ width: 3000, height: 7 })
    expect(imageDimensions(Buffer.from('not an image'))).toBeNull()
  })
})

describe('fitImagesToProviderLimit', () => {
  it('shrinks a 2048 px PNG and JPEG to 2000 px in their own format', () => {
    const [p, j] = fitImagesToProviderLimit([
      { url: dataUrl('image/png', png(2048, 1024)), mimeType: 'image/png', name: 'wide.png' },
      { url: dataUrl('image/jpeg', jpeg(1024, 2048)), mimeType: 'image/jpeg', name: 'tall.jpg' },
    ])!
    expect(p.url.startsWith('data:image/png;base64,')).toBe(true)
    expect(PNG.sync.read(Buffer.from(p.url.split(',')[1], 'base64'))).toMatchObject({ width: 2000, height: 1000 })
    expect(j.url.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(decodeJpeg(Buffer.from(j.url.split(',')[1], 'base64'))).toMatchObject({ width: 1000, height: 2000 })
    expect(p.name).toBe('wide.png')
  })

  it('leaves an image within the limit untouched', () => {
    const image = { url: dataUrl('image/png', png(2000, 10)), mimeType: 'image/png' }
    expect(fitImagesToProviderLimit([image])![0]).toBe(image)
  })

  it('refuses a GIF over the limit, naming it', () => {
    expect(() =>
      fitImagesToProviderLimit([{ url: dataUrl('image/gif', gifHeader(2048, 10)), name: 'party.gif' }]),
    ).toThrow('party.gif is 2048 px on its long side; the limit is 2000 px')
  })
})

describe('fitImagesToProviderLimit refusals', () => {
  it('refuses a PNG that claims too many pixels before decoding it', () => {
    const header = png(1, 1)
    header.writeUInt32BE(10_000, 16)
    header.writeUInt32BE(10_000, 20)
    expect(() => fitImagesToProviderLimit([{ url: dataUrl('image/png', header), name: 'bomb.png' }])).toThrow(
      'bomb.png is 10000 x 10000 px, too large to shrink to 2000 px',
    )
  })

  it('refuses JPEG bytes labelled as PNG, naming the image', () => {
    expect(() => fitImagesToProviderLimit([{ url: dataUrl('image/png', jpeg(2048, 8)), name: 'odd.png' }])).toThrow(
      'odd.png is 2048 px on its long side',
    )
  })
})

describe('imageTypeOf', () => {
  it('takes the type from the extension when the MIME type is missing', () => {
    expect(imageTypeOf({ type: '', name: 'Shot.PNG' })).toBe('image/png')
    expect(imageTypeOf({ type: '', name: 'IMG_0001.HEIC' })).toBe('image/heic')
    expect(imageTypeOf({ type: 'application/octet-stream', name: 'a.jpeg' })).toBe('image/jpeg')
    expect(imageTypeOf({ type: 'image/webp', name: 'x.bin' })).toBe('image/webp')
    expect(imageTypeOf({ type: 'text/plain', name: 'notes.png' })).toBe('')
    expect(imageTypeOf({ type: '', name: 'notes.txt' })).toBe('')
  })
})
