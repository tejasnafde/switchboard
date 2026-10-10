/**
 * Picked photos to the shape SEND_TURN expects: a data URL plus a mimeType,
 * matching the desktop composer. Pure, so the size rules are testable; the
 * resize rules live in `@shared/image-resize`.
 */
import { MESSAGE_IMAGE_WIRE_BUDGET } from '@shared/image-resize'

export interface ImagePayload {
  /** `data:<mime>;base64,<data>` */
  url: string
  mimeType: string
}

/** Minimal shape of an expo-image-picker asset, so this file needs no import. */
export interface PickedAsset {
  uri: string
  mimeType?: string | null
  fileName?: string | null
}

/** Ceiling on the complete encoded data URLs attached to one turn. */
export const MAX_TURN_WIRE_BYTES = MESSAGE_IMAGE_WIRE_BUDGET

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
export function inferMimeType(asset: Pick<PickedAsset, 'uri' | 'mimeType' | 'fileName'>): string | null {
  const reported = canonicalMimeType(asset.mimeType)
  if (reported) return reported
  if (asset.mimeType?.trim().toLowerCase().startsWith('image/')) return null
  const name = asset.fileName ?? asset.uri
  const ext = name.split('?')[0].split('.').pop()?.toLowerCase()
  return (ext && EXT_TO_MIME[ext]) || null
}

/** Wire cost of the attachments as they will be sent. */
export function totalWireBytes(payloads: Array<Pick<ImagePayload, 'url'>>): number {
  return payloads.reduce((n, p) => n + p.url.length, 0)
}

/**
 * The type that picks the resize path (`resizeAttempts`). Every image but a GIF
 * is re-encoded, so a type we cannot send as is (HEIC from an iPhone) is fine
 * once the decoder can read it, and is treated as a photo.
 */
export function resizeSourceType(asset: Pick<PickedAsset, 'uri' | 'mimeType' | 'fileName'>): string | null {
  return inferMimeType(asset) ?? (asset.mimeType?.trim().toLowerCase().startsWith('image/') ? 'image/jpeg' : null)
}
