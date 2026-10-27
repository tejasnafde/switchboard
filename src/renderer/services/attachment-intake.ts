import { imageTypeOf, isHeicType } from '@shared/image-resize'
import { USER_MESSAGE_IMAGE_TYPES } from '@shared/provider-events'

/** Largest source image the composer takes; it is shrunk to the message budget at send. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** A file the composer did not attach, and why. Shown one per line above the editor. */
export interface AttachmentRefusal {
  name: string
  reason: string
}

const SUPPORTED_IMAGES: readonly string[] = USER_MESSAGE_IMAGE_TYPES

function megabytes(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))} MB`
}

/** `image/tiff` -> `TIFF`, `image/svg+xml` -> `SVG`. */
function imageFormat(type: string): string {
  return type.slice('image/'.length).split('+')[0].toUpperCase()
}

/** Split dropped, pasted or picked files into images to attach and refusals that name each file. */
export function sortAttachments(files: File[]): { images: File[]; refused: AttachmentRefusal[] } {
  const images: File[] = []
  const refused: AttachmentRefusal[] = []
  for (const file of files) {
    // HEIC/HEIF passes here: the intake converts it to JPEG.
    const type = imageTypeOf(file)
    if (!type) {
      refused.push({ name: file.name, reason: 'Only images can be attached.' })
    } else if (!SUPPORTED_IMAGES.includes(type) && !isHeicType(type)) {
      refused.push({
        name: file.name,
        reason: `${imageFormat(type)} images are not supported. Use PNG, JPEG, WebP, GIF or HEIC.`,
      })
    } else if (file.size > MAX_IMAGE_BYTES) {
      refused.push({
        name: file.name,
        reason: `${megabytes(file.size)} is over the ${megabytes(MAX_IMAGE_BYTES)} image limit.`,
      })
    } else {
      images.push(file)
    }
  }
  return { images, refused }
}
