import { imageTypeOf, isHeicType } from '@shared/image-resize'
import { USER_MESSAGE_IMAGE_TYPES } from '@shared/provider-events'
import { MAX_ATTACHMENT_BYTES } from '@shared/attachments'

/** Largest source image the composer takes; it is shrunk to the message budget at send. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** Pasted text over this many bytes becomes a `pasted-text-N.txt` attachment. */
export const LARGE_PASTE_BYTES = 32 * 1024

/** A file the composer did not attach, and why. Shown one per line above the editor. */
export interface AttachmentRefusal {
  name: string
  reason: string
}

const SUPPORTED_IMAGES: readonly string[] = USER_MESSAGE_IMAGE_TYPES

function megabytes(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))} MB`
}

/** `image/tiff` -> `TIFF`. */
function imageFormat(type: string): string {
  return type.slice('image/'.length).split('+')[0].toUpperCase()
}

/**
 * Split dropped, pasted or picked files into images (sent inline), files
 * (saved and sent as a path), folders (sent as a path) and refusals that name
 * each file. An SVG goes as a file: no provider takes it as an image.
 */
export function sortAttachments(
  files: File[],
  isFolder: (file: File) => boolean = () => false,
): { images: File[]; files: File[]; folders: File[]; refused: AttachmentRefusal[] } {
  const out = { images: [] as File[], files: [] as File[], folders: [] as File[], refused: [] as AttachmentRefusal[] }
  for (const file of files) {
    // HEIC/HEIF counts as an image: the intake converts it to JPEG.
    const type = imageTypeOf(file)
    if (isFolder(file)) {
      out.folders.push(file)
    } else if (SUPPORTED_IMAGES.includes(type) || isHeicType(type)) {
      if (file.size > MAX_IMAGE_BYTES)
        out.refused.push({
          name: file.name,
          reason: `${megabytes(file.size)} is over the ${megabytes(MAX_IMAGE_BYTES)} image limit.`,
        })
      else out.images.push(file)
    } else if (type.startsWith('image/') && type !== 'image/svg+xml') {
      out.refused.push({
        name: file.name,
        reason: `${imageFormat(type)} images are not supported. Use PNG, JPEG, WebP, GIF or HEIC.`,
      })
    } else if (file.size > MAX_ATTACHMENT_BYTES) {
      out.refused.push({
        name: file.name,
        reason: `${megabytes(file.size)} is over the ${megabytes(MAX_ATTACHMENT_BYTES)} file limit.`,
      })
    } else {
      out.files.push(file)
    }
  }
  return out
}

/** `1,234` for a count on a chip. */
const count = (n: number): string => n.toLocaleString('en-US')

/** The chip label of a saved attachment: `spec.pdf (12 pages)`, `log.txt (2,140 lines)`, or the name. */
export function attachmentLabel(name: string, detail: { pages?: number; lines?: number; entries?: number }): string {
  if (detail.entries !== undefined)
    return `${name}/ (${count(detail.entries)} ${detail.entries === 1 ? 'file' : 'files'})`
  if (detail.pages && detail.pages > 1) return `${name} (${count(detail.pages)} pages)`
  if (detail.lines && detail.lines > 1) return `${name} (${count(detail.lines)} lines)`
  return name
}
