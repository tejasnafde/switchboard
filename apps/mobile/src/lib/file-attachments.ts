/**
 * Composer file attachments: which picked files go as images, which upload as
 * files, which are refused and why, and when a paste becomes a file. Pure, so
 * the rules are testable; the picker and the upload live in the components.
 * The desktop's rules are `sortAttachments` in the renderer's attachment-intake.
 */
import { LARGE_PASTE_BYTES, MAX_UPLOAD_ATTACHMENT_BYTES, type SentAttachment } from '@shared/attachments'
import { imageTypeOf, isHeicType } from '@shared/image-resize'
import { USER_MESSAGE_IMAGE_TYPES } from '@shared/provider-events'

/** A file from the document picker, as far as these rules need it. */
export interface PickedFile {
  name: string
  mimeType?: string | null
  /** Bytes, when the picker reports it. */
  size?: number | null
}

export type PickedFileRoute =
  /** `sourceType` picks the resize path: a HEIC is re-encoded as a photo. */
  { kind: 'image'; sourceType: string } | { kind: 'file' } | { kind: 'refused'; reason: string }

function megabytes(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))} MB`
}

/** `image/tiff` -> `TIFF`. */
function imageFormat(type: string): string {
  return type.slice('image/'.length).split('+')[0].toUpperCase()
}

export const FILES_NEED_UPDATE = 'This machine takes images only. Update Switchboard on it to attach files.'

/** Where one picked file goes. `canUpload` is the backend's `attachment_upload_v1`. */
export function routePickedFile(file: PickedFile, canUpload: boolean): PickedFileRoute {
  const type = imageTypeOf({ type: file.mimeType ?? '', name: file.name })
  if (USER_MESSAGE_IMAGE_TYPES.includes(type)) return { kind: 'image', sourceType: type }
  if (isHeicType(type)) return { kind: 'image', sourceType: 'image/jpeg' }
  // An SVG goes as a file: no provider takes it as an image.
  if (type.startsWith('image/') && type !== 'image/svg+xml')
    return {
      kind: 'refused',
      reason: `${imageFormat(type)} images are not supported. Use PNG, JPEG, WebP, GIF or HEIC.`,
    }
  if (!canUpload) return { kind: 'refused', reason: FILES_NEED_UPDATE }
  const tooLarge = fileTooLarge(file.size ?? 0)
  return tooLarge ? { kind: 'refused', reason: tooLarge } : { kind: 'file' }
}

/** The refusal for a file of `bytes`, or null when it fits the upload limit. */
export function fileTooLarge(bytes: number): string | null {
  return bytes > MAX_UPLOAD_ATTACHMENT_BYTES
    ? `${megabytes(bytes)} is over the ${megabytes(MAX_UPLOAD_ATTACHMENT_BYTES)} file limit.`
    : null
}

/** One line of the composer notice, the desktop's wording. */
export function refusalLine(name: string, reason: string): string {
  return `${name} was not attached: ${reason}`
}

/** The decoded size of a base64 string. */
export function base64Bytes(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor((b64.length * 3) / 4) - padding
}

/** UTF-8 length of a string, without TextEncoder. */
export function utf8Bytes(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

function utf8Encode(text: string): number[] {
  const out: number[] = []
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** The UTF-8 bytes of `text` as base64, for `app:upload-attachment`. */
export function utf8Base64(text: string): string {
  const bytes = utf8Encode(text)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)]
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '='
    out += i + 2 < bytes.length ? B64[c & 63] : '='
  }
  return out
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff

/**
 * A TextInput change that pasted more than LARGE_PASTE_BYTES: the inserted
 * run, where it starts, and the text without it. Null for any other change.
 * React Native gives no paste event, so the run is the part of `next` that
 * differs from `prev`.
 */
export function largePaste(prev: string, next: string): { inserted: string; at: number; kept: string } | null {
  // A UTF-16 unit is at most 3 UTF-8 bytes: a short text cannot qualify.
  if (next.length * 3 <= LARGE_PASTE_BYTES) return null
  let start = 0
  const max = Math.min(prev.length, next.length)
  while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) start++
  if (start > 0 && start < next.length && isHigh(next.charCodeAt(start - 1))) start--
  let end = 0
  while (end < max - start && prev.charCodeAt(prev.length - 1 - end) === next.charCodeAt(next.length - 1 - end)) end++
  if (end > 0 && isLow(next.charCodeAt(next.length - end))) end--
  const inserted = next.slice(start, next.length - end)
  const replaced = prev.slice(start, prev.length - end)
  if (utf8Bytes(inserted) - utf8Bytes(replaced) <= LARGE_PASTE_BYTES) return null
  return { inserted, at: start, kept: next.slice(0, start) + next.slice(next.length - end) }
}

/** A failed paste upload puts the text back where it was, or at the end of a shorter draft. */
export function reinsertPaste(current: string, at: number, inserted: string): string {
  const i = Math.min(at, current.length)
  return current.slice(0, i) + inserted + current.slice(i)
}

/** A file chip in the composer. No `path` while its upload runs. */
export interface ComposerFile {
  id: string
  name: string
  label: string
  path?: string
}

/** The chips whose upload finished, in the shape `attachmentTurn` takes. */
export function sentAttachments(files: readonly ComposerFile[]): SentAttachment[] {
  return files.flatMap((f) => (f.path ? [{ id: f.id, name: f.name, path: f.path, label: f.label }] : []))
}

export function uploadsRunning(files: readonly ComposerFile[]): number {
  return files.filter((f) => !f.path).length
}

/** A pill id the `[[pill:id]]` token accepts. */
export function newFileId(): string {
  return `file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
