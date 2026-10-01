/**
 * The strip under a chat's header naming the sessions it is linked with
 * (`/link`), each with how much of its exchange budget is spent. One link:
 * an Unlink button. Several: a popover with one Unlink per link plus
 * Unlink all. The backend holds the links; this follows its broadcast.
 */
import { useEffect, useState } from 'react'
import { peerLinkLabel, peerLinksBannerText, type PeerLinkView } from '@shared/peer-links'
import { createRendererLogger } from '../../logger'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

const log = createRendererLogger('chat:peer-links')

/** Re-render this often while linked, so a link whose window closes reads "time up". */
const CLOCK_TICK_MS = 30_000

function usePeerLinks(sessionId: string): PeerLinkView[] {
  const [links, setLinks] = useState<PeerLinkView[]>([])
  useEffect(() => {
    let live = true
    const load = () => window.api.provider.listPeerLinks({ threadId: sessionId })
      .then((next) => { if (live) setLinks(next) })
      .catch((err) => log.warn('reading session links failed', err))
    void load()
    const stop = window.api.provider.onPeerLinksChanged(() => void load())
    return () => {
      live = false
      stop()
    }
  }, [sessionId])
  return links
}

export function PeerLinkBanner({ sessionId }: { sessionId: string }) {
  const links = usePeerLinks(sessionId)
  const [now, setNow] = useState(() => Date.now())
  const [open, setOpen] = useState(false)
  const hasLinks = links.length > 0

  useEffect(() => {
    if (!hasLinks) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [hasLinks, links])

  if (!hasLinks) return null

  const unlink = (peerThreadId?: string) => {
    setOpen(false)
    window.api.provider.unlinkPeer({ threadId: sessionId, ...(peerThreadId ? { peerThreadId } : {}) })
      .catch((err) => log.warn('unlinking sessions failed', err))
  }
  const text = peerLinksBannerText(links, now)

  return (
    <aside
      aria-label="Session links"
      data-testid="peer-link-banner"
      className="flex min-h-[32px] shrink-0 items-center gap-2 border-b border-[var(--border)] px-4 py-[3px] text-[11px] text-[var(--text-muted)]"
    >
      <span aria-hidden="true">⇄</span>
      <span className="min-w-0 truncate" title={links.map((link) => peerLinkLabel(link, now)).join(', ')}>{text}</span>
      {links.length === 1 ? (
        <Button variant="ghost" size="sm" className="ml-auto text-[var(--accent)]" onClick={() => unlink(links[0].peerThreadId)}>
          Unlink
        </Button>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="ml-auto text-[var(--accent)]">
              Unlink
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="sb-floating-surface z-[1200] w-[300px] overflow-hidden rounded-[8px] border border-[var(--border)] p-1 text-[12.5px] text-[var(--text-primary)]">
            {links.map((link) => (
              <div key={link.peerThreadId} className="flex items-center gap-2 rounded-[6px] px-2 py-[4px]">
                <span className="min-w-0 flex-1 truncate">{peerLinkLabel(link, now)}</span>
                <Button variant="ghost" size="sm" onClick={() => unlink(link.peerThreadId)}>Unlink</Button>
              </div>
            ))}
            <div className="mt-1 flex justify-end border-t border-[var(--border)] px-1 pt-1">
              <Button variant="ghost" size="sm" onClick={() => unlink()}>Unlink all</Button>
            </div>
          </PopoverContent>
        </Popover>
      )}
    </aside>
  )
}
