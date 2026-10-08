import { useEffect, useRef, useState } from 'react'
import type { MessageImage } from '@shared/types'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('chat:history-image')

// Rows unmount as the list scrolls; keep recent bytes so scrolling back does
// not fetch them again. ponytail: count-capped, a byte budget if images grow.
const MAX_LOADED = 64
const loaded = new Map<string, string>()

function remember(key: string, url: string): void {
  loaded.delete(key)
  loaded.set(key, url)
  if (loaded.size > MAX_LOADED) loaded.delete(loaded.keys().next().value as string)
}

/** An image sent by reference loads its bytes once it scrolls into view. */
function useImageUrl(image: MessageImage, sessionId: string | undefined): [string, React.RefObject<HTMLDivElement | null>] {
  const ref = image.ref
  const key = ref && sessionId ? `${sessionId}\0${ref.messageId}\0${ref.index}` : ''
  const [url, setUrl] = useState(() => image.url || loaded.get(key) || '')
  const boxRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (image.url) {
      setUrl(image.url)
      return
    }
    const known = loaded.get(key)
    if (known) {
      setUrl(known)
      return
    }
    const box = boxRef.current
    if (!ref || !sessionId || !box) return
    let cancelled = false
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      window.api.app.loadHistoryImage(sessionId, ref.messageId, ref.index)
        .then((result) => {
          if (!result?.url) {
            log.warn('history image not found', { sessionId, messageId: ref.messageId, index: ref.index })
            return
          }
          remember(key, result.url)
          if (!cancelled) setUrl(result.url)
        })
        .catch((err) => log.warn('history image load failed', { sessionId, messageId: ref.messageId, err }))
    })
    observer.observe(box)
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [image.url, key, ref, sessionId])

  return [url, boxRef]
}

function Thumbnail({ image, sessionId, onOpen }: { image: MessageImage; sessionId?: string; onOpen: (url: string) => void }) {
  const [url, boxRef] = useImageUrl(image, sessionId)
  return (
    <div
      ref={boxRef}
      onClick={() => { if (url) onOpen(url) }}
      className="h-[90px] w-[120px] cursor-pointer overflow-hidden rounded-[6px] border border-[var(--border)] transition-opacity duration-[120ms] hover:opacity-[0.85]"
    >
      {url && <img src={url} alt={image.name || 'attachment'} className="h-full w-full object-cover" />}
    </div>
  )
}

export function MessageImages({ images, sessionId, spaced, onOpen }: {
  images: MessageImage[]
  sessionId?: string
  /** Text sits above the images. */
  spaced: boolean
  onOpen: (url: string) => void
}) {
  return (
    <div className={`flex flex-wrap gap-[6px] ${spaced ? 'mt-[8px]' : 'mt-0'}`}>
      {images.map((image, i) => <Thumbnail key={i} image={image} sessionId={sessionId} onOpen={onOpen} />)}
    </div>
  )
}
