/**
 * Data URLs of history images last sent by reference (`imageRefs`), so
 * `app:load-history-image` answers without re-reading the transcript. The
 * strings are usually the parse cache's own, so this mostly holds pointers.
 * A miss (evicted, or a backend restart) falls back to the full history.
 */
const MAX_CHARS = 64 * 1024 * 1024
const images = new Map<string, string>() // insertion order = LRU order
let totalChars = 0

const keyOf = (threadId: string, messageId: string, index: number) => `${threadId}\0${messageId}\0${index}`

export function rememberHistoryImage(threadId: string, messageId: string, index: number, url: string): void {
  const key = keyOf(threadId, messageId, index)
  const prev = images.get(key)
  if (prev !== undefined) {
    images.delete(key)
    totalChars -= prev.length
  }
  images.set(key, url)
  totalChars += url.length
  while (totalChars > MAX_CHARS && images.size > 1) {
    const [oldKey, oldUrl] = images.entries().next().value as [string, string]
    images.delete(oldKey)
    totalChars -= oldUrl.length
  }
}

export function rememberedHistoryImage(threadId: string, messageId: string, index: number): string | null {
  return images.get(keyOf(threadId, messageId, index)) ?? null
}
