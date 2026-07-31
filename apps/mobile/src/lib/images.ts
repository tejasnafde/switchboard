/**
 * Turning picked photos into what SEND_TURN expects.
 *
 * The wire format matches the desktop composer: a data URL plus an explicit
 * mimeType. Adapters strip the prefix and build provider-native image blocks, so
 * nothing here needs per-provider knowledge.
 *
 * Pure, so the size and type rules are testable without a device.
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

/**
 * Cap on a single encoded image. Base64 inflates by about a third, and each
 * image crosses a phone socket and then goes into a model request, so a 20 MB
 * photo is not worth attempting. Matches the desktop file-write ceiling.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
}

/**
 * Best-effort media type. The picker usually reports one; when it does not, the
 * file extension is the only other signal, and JPEG is the right guess for a
 * camera roll.
 */
export function inferMimeType(asset: Pick<PickedAsset, 'uri' | 'mimeType' | 'fileName'>): string {
  if (asset.mimeType && asset.mimeType.startsWith('image/')) return asset.mimeType
  const name = asset.fileName ?? asset.uri
  const ext = name.split('?')[0].split('.').pop()?.toLowerCase()
  return (ext && EXT_TO_MIME[ext]) || 'image/jpeg'
}

/** Decoded byte length of a base64 string, without decoding it. */
export function base64ByteLength(b64: string): number {
  const clean = b64.replace(/=+$/, '')
  return Math.floor((clean.length * 3) / 4)
}

export type ImageResult =
  | { ok: true; payload: ImagePayload }
  | { ok: false; reason: 'no-data' | 'too-large' }

/**
 * `base64` must be requested from the picker (`base64: true`). Without it there
 * is nothing to send: a `file://` uri means nothing to a backend that may be on
 * another machine entirely.
 */
export function assetToPayload(asset: PickedAsset): ImageResult {
  const b64 = asset.base64
  if (!b64) return { ok: false, reason: 'no-data' }
  if (base64ByteLength(b64) > MAX_IMAGE_BYTES) return { ok: false, reason: 'too-large' }
  const mimeType = inferMimeType(asset)
  return { ok: true, payload: { url: `data:${mimeType};base64,${b64}`, mimeType } }
}

/**
 * Ceiling on the combined size of one turn's attachments, measured as the bytes
 * that actually cross the wire (the data URLs).
 *
 * This exists because the IAP transport's frame cap is enforced by DESTROYING
 * the connection, not by rejecting the frame - so an oversized turn would look
 * like the backend dropping out. Kept well under that cap.
 */
export const MAX_TURN_WIRE_BYTES = 12 * 1024 * 1024

/** Wire cost of the attachments as they will be sent. */
export function totalWireBytes(payloads: Array<Pick<ImagePayload, 'url'>>): number {
  return payloads.reduce((n, p) => n + p.url.length, 0)
}

/**
 * Split additions into those that fit the remaining turn budget and those that
 * do not, in order. Callers must tell the user about `rejected` rather than
 * quietly sending fewer images than were picked.
 */
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
