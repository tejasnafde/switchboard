/**
 * Keeps every image a provider gets at `MAX_IMAGE_LONG_SIDE` or less on its
 * long side, whatever client sent it: an older phone build (2048 px steps), a
 * re-send of an image stored before the limit, or a client that skipped the
 * resize. Pure JS codecs, so the headless server runs it too.
 */
import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js'
import { PNG } from 'pngjs'
import { fitWithin, MAX_IMAGE_LONG_SIDE } from '@shared/image-resize'
import { parseImageDataUrl } from '@shared/provider-events'

const JPEG_QUALITY = 85
/** Decoding past this would take gigabytes; a small PNG can claim any size. */
const MAX_DECODE_PIXELS = 50_000_000

/** Pixel size from the image header (PNG, JPEG, GIF, WebP), or null when unknown. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length))
  if (bytes.length >= 24 && ascii(1, 3) === 'PNG') {
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (bytes.length >= 10 && ascii(0, 4) === 'GIF8') {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  }
  if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4)
    if (chunk === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    if (chunk === 'VP8L') {
      const bits = view.getUint32(21, true)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (chunk === 'VP8X') {
      const u24 = (at: number) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)
      return { width: u24(24) + 1, height: u24(27) + 1 }
    }
    return null
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null
      const marker = bytes[at + 1]
      if (marker === 0xff) {
        at++
        continue
      }
      // Start of frame: every SOFn but DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) }
      }
      at += 2 + view.getUint16(at + 2)
    }
  }
  return null
}

/** Box-filter downscale of RGBA pixels: each output pixel averages the source pixels it covers. */
function downscaleRgba(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Buffer {
  const out = Buffer.alloc(dw * dh * 4)
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh))
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * sw + sx) * 4
          r += src[i]
          g += src[i + 1]
          b += src[i + 2]
          a += src[i + 3]
        }
      }
      const n = (y1 - y0) * (x1 - x0)
      const o = (y * dw + x) * 4
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
      out[o + 3] = Math.round(a / n)
    }
  }
  return out
}

/** Re-encode a PNG or JPEG at no more than `MAX_IMAGE_LONG_SIDE`, in its own format. */
function shrink(mimeType: string, bytes: Buffer): Buffer {
  const decoded =
    mimeType === 'image/png'
      ? PNG.sync.read(bytes)
      : decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 })
  const size = fitWithin(decoded.width, decoded.height, MAX_IMAGE_LONG_SIDE)
  const data = downscaleRgba(decoded.data, decoded.width, decoded.height, size.width, size.height)
  if (mimeType === 'image/png') {
    const png = new PNG({ width: size.width, height: size.height })
    data.copy(png.data)
    return PNG.sync.write(png)
  }
  return encodeJpeg({ data, width: size.width, height: size.height }, JPEG_QUALITY).data
}

/**
 * The images with any side over `MAX_IMAGE_LONG_SIDE` shrunk to it. A GIF or
 * WebP that is too large is refused (a GIF would lose its animation). An
 * image this cannot read is passed on unchanged for the validator to judge.
 */
export function fitImagesToProviderLimit<T extends { url: string; mimeType?: string; name?: string }>(
  images: T[] | undefined,
): T[] | undefined {
  if (!Array.isArray(images) || !images.length) return images
  return images.map((image) => {
    const parsed = parseImageDataUrl(image.url)
    if (!parsed) return image
    const bytes = Buffer.from(parsed.data, 'base64')
    const size = imageDimensions(bytes)
    if (!size || Math.max(size.width, size.height) <= MAX_IMAGE_LONG_SIDE) return image
    const name = image.name || 'An image'
    const isPng = bytes[0] === 0x89
    const sniffed = isPng ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : null
    if (sniffed !== parsed.mimeType) {
      throw new Error(
        `${name} is ${Math.max(size.width, size.height)} px on its long side; the limit is ${MAX_IMAGE_LONG_SIDE} px`,
      )
    }
    if (size.width * size.height > MAX_DECODE_PIXELS) {
      throw new Error(`${name} is ${size.width} x ${size.height} px, too large to shrink to ${MAX_IMAGE_LONG_SIDE} px`)
    }
    const shrunk = shrink(parsed.mimeType, bytes)
    return { ...image, url: `data:${parsed.mimeType};base64,${shrunk.toString('base64')}` }
  })
}
