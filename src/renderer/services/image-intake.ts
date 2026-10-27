import { imageTypeOf, isHeicType } from '@shared/image-resize'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('chat:image-intake')

/**
 * A dropped, pasted or picked file as a composer image, or null when it is not
 * an image. A missing MIME type is taken from the extension, and a HEIC/HEIF
 * becomes a JPEG. A HEIC that does not convert is kept, so sending it names it
 * as unreadable.
 */
export async function toComposerImage(file: File): Promise<File | null> {
  const type = imageTypeOf(file)
  if (!type) return null
  if (isHeicType(type)) {
    try {
      const jpeg = await window.api.app.convertHeic(new Uint8Array(await file.arrayBuffer()))
      return new File([jpeg], file.name.replace(/\.hei[cf]$/i, '') + '.jpg', { type: 'image/jpeg' })
    } catch (err) {
      log.warn('HEIC conversion failed', { name: file.name, err })
    }
  }
  return type === file.type ? file : new File([file], file.name, { type })
}
