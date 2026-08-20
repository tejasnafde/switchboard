/**
 * Picked photos to the shape SEND_TURN expects: a data URL plus a mimeType,
 * matching the desktop composer. Pure, so the size rules are testable.
 */

export interface ImagePayload {
  /** `data:<mime>;base64,<data>` */
  url: string
  mimeType: string
}

/** Minimal shape of an expo-image-picker asset, so this file needs no import. */
export interface PickedAsset {
  uri: string
  base64?: string | null
  mimeType?: string | null
  fileName?: string | null
}

/** Ceiling on the complete encoded data URLs attached to one turn. */
export const MAX_TURN_WIRE_BYTES = 3 * 1024 * 1024

/** Largest decoded payload that could fit before the data-URL header is added. */
export const MAX_IMAGE_BYTES = Math.floor(MAX_TURN_WIRE_BYTES * 3 / 4)

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

const SUPPORTED_MIME_TYPES = new Set(Object.values(EXT_TO_MIME))

function canonicalMimeType(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'image/jpg') return 'image/jpeg'
  return normalized && SUPPORTED_MIME_TYPES.has(normalized) ? normalized : null
}

/** Picker-reported type, else a supported extension. Unknown bytes stay unknown. */
export function inferMimeType(
  asset: Pick<PickedAsset, 'uri' | 'mimeType' | 'fileName'>,
): string | null {
  const reported = canonicalMimeType(asset.mimeType)
  if (reported) return reported
  if (asset.mimeType?.trim().toLowerCase().startsWith('image/')) return null
  const name = asset.fileName ?? asset.uri
  const ext = name.split('?')[0].split('.').pop()?.toLowerCase()
  return (ext && EXT_TO_MIME[ext]) || null
}

/** Decoded byte length of a base64 string, without decoding it. */
export function base64ByteLength(b64: string): number {
  const clean = b64.replace(/=+$/, '')
  return Math.floor((clean.length * 3) / 4)
}

export type ImageResult =
  | { ok: true; payload: ImagePayload }
  | { ok: false; reason: 'no-data' | 'too-large' | 'unsupported-type' }

/** Needs `base64: true` from the picker - a file:// uri means nothing to a remote backend. */
export function assetToPayload(asset: PickedAsset): ImageResult {
  const b64 = asset.base64
  if (!b64) return { ok: false, reason: 'no-data' }
  if (base64ByteLength(b64) > MAX_IMAGE_BYTES) return { ok: false, reason: 'too-large' }
  const mimeType = inferMimeType(asset)
  if (!mimeType) return { ok: false, reason: 'unsupported-type' }
  const payload = { url: `data:${mimeType};base64,${b64}`, mimeType }
  if (payload.url.length > MAX_TURN_WIRE_BYTES) return { ok: false, reason: 'too-large' }
  return { ok: true, payload }
}

/** Wire cost of the attachments as they will be sent. */
export function totalWireBytes(payloads: Array<Pick<ImagePayload, 'url'>>): number {
  return payloads.reduce((n, p) => n + p.url.length, 0)
}

/** Split additions by what fits the remaining budget. Callers must report `rejected`. */
export function fitTurnBudget<T extends Pick<ImagePayload, 'url'>>(
  existing: Array<Pick<ImagePayload, 'url'>>,
  additions: T[],
): { accepted: T[]; rejected: T[] } {
  let used = totalWireBytes(existing)
  const accepted: T[] = []
  const rejected: T[] = []
  for (const a of additions) {
    if (used + a.url.length > MAX_TURN_WIRE_BYTES) {
      rejected.push(a)
      continue
    }
    used += a.url.length
    accepted.push(a)
  }
  return { accepted, rejected }
}

/** Human-readable size, for the "too large" message. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
