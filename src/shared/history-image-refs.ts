import type { ChatMessage } from './types'

export const HISTORY_IMAGE_REFS_CAPABILITY = 'history_image_refs_v1'

/** Decoded byte size of a base64 data URL, without decoding it. */
export function dataUrlBytes(url: string): number {
  const comma = url.indexOf(',')
  const b64 = comma < 0 ? '' : url.slice(comma + 1)
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(b64.length * 3 / 4) - padding)
}

/**
 * Swap each base64 history image for a reference. `remember` receives every
 * data URL it replaced so the backend can serve it back by reference.
 * Remote (http) images stay as they are: they carry no bytes.
 */
export function imagesByReference(
  messages: ChatMessage[],
  remember: (messageId: string, index: number, url: string) => void,
): ChatMessage[] {
  return messages.map((message) => {
    if (!message.images?.some((image) => image.url.startsWith('data:'))) return message
    return {
      ...message,
      images: message.images.map((image, index) => {
        if (!image.url.startsWith('data:')) return image
        remember(message.id, index, image.url)
        return { ...image, url: '', ref: { messageId: message.id, index, bytes: dataUrlBytes(image.url) } }
      }),
    }
  })
}
