/**
 * Downscale a pasted/dropped image to keep DB rows small without making
 * it visibly pixel-y. Strategy:
 *   • cap the longest edge at `maxEdge` (default 1920px — hidpi laptop screen)
 *   • encode JPEG q=0.85 for opaque sources, keep PNG for sources with
 *     transparency so we don't fringe the alpha channel
 *   • skip work entirely if the image is already small (no upscale, no recompress)
 *
 * Returned `dataUrl` is ready to drop into a markdown `![](...)` embed.
 */

export interface DownscaleResult {
  dataUrl: string
  width: number
  height: number
  /** True when output equals input (no recompression happened). */
  passthrough: boolean
}

/** Pure: compute target dimensions, preserving aspect ratio. */
export function computeTargetSize(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number; scaled: boolean } {
  if (width <= 0 || height <= 0) return { width, height, scaled: false }
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { width, height, scaled: false }
  const ratio = maxEdge / longest
  return {
    width: Math.round(width * ratio),
    height: Math.round(height * ratio),
    scaled: true,
  }
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image decode failed'))
    img.src = url
  })
}

export async function downscaleImage(
  file: File,
  opts: { maxEdge?: number; jpegQuality?: number } = {},
): Promise<DownscaleResult> {
  const maxEdge = opts.maxEdge ?? 1920
  const jpegQuality = opts.jpegQuality ?? 0.85

  const sourceUrl = await readAsDataUrl(file)
  const img = await loadImage(sourceUrl)
  const target = computeTargetSize(img.naturalWidth, img.naturalHeight, maxEdge)

  // Already small enough — emit the original bytes untouched.
  if (!target.scaled) {
    return { dataUrl: sourceUrl, width: target.width, height: target.height, passthrough: true }
  }

  const canvas = document.createElement('canvas')
  canvas.width = target.width
  canvas.height = target.height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return { dataUrl: sourceUrl, width: img.naturalWidth, height: img.naturalHeight, passthrough: true }
  }
  // High-quality resampling. Defaults vary by browser; set explicitly.
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, target.width, target.height)

  // Preserve alpha for PNG/WEBP; JPEG-compress everything else.
  const keepAlpha = file.type === 'image/png' || file.type === 'image/webp' || file.type === 'image/gif'
  const outType = keepAlpha ? 'image/png' : 'image/jpeg'
  const outQuality = keepAlpha ? undefined : jpegQuality
  const dataUrl = canvas.toDataURL(outType, outQuality)
  return { dataUrl, width: target.width, height: target.height, passthrough: false }
}
