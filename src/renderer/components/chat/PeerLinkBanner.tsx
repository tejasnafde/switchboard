/**
 * The strip under a chat's header naming the sessions it is linked with
 * (`/link`), each with how much of its exchange budget is spent. One link:
 * Extend and Unlink inline. Several (any number): a count, and a scrolling
 * popover with Extend and Unlink per link plus Unlink all. The backend holds
 * the links; this follows its broadcast.
 */
import { useEffect, useState } from 'react'
import { peerLinkLabel, peerLinksBannerText, PEER_LINK_EXTEND_MESSAGES, type PeerLinkView } from '@shared/peer-links'
import { createRendererLogger } from '../../logger'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

const log = createRendererLogger('chat:peer-links')

/** Re-render this often while linked, so a link whose window closes reads "time up". */
const CLOCK_TICK_MS = 30_000
const EXTENDED_FEEDBACK_MS = 2_000

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
  const [error, setError] = useState<string | null>(null)
  // Extend changes only a number in the text, so it says it worked: a spinner
  // while the call runs, then "Extended" and an accent flash on the text.
  const [extending, setExtending] = useState<string | null>(null)
  const [extended, setExtended] = useState<string | null>(null)
  useEffect(() => {
    if (!extended) return
    const timer = setTimeout(() => setExtended(null), EXTENDED_FEEDBACK_MS)
    return () => clearTimeout(timer)
  }, [extended])
  const hasLinks = links.length > 0

  useEffect(() => {
    if (!hasLinks) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [hasLinks, links])

  if (!hasLinks) return null

  const act = (what: string, call: () => Promise<unknown>) => {
    setError(null)
    call().catch((err) => {
      log.warn(`${what} failed`, err)
      setError(err instanceof Error ? err.message : String(err))
    })
  }
  const unlink = (peerThreadId?: string) => {
    if (!peerThreadId) setOpen(false)
    act('unlinking sessions', () => window.api.provider.unlinkPeer({ threadId: sessionId, ...(peerThreadId ? { peerThreadId } : {}) }))
  }
  const extend = (peerThreadId: string) => {
    setExtending(peerThreadId)
    act('extending a session link', () => window.api.provider.extendPeerLink({ threadId: sessionId, peerThreadId })
      .then(() => setExtended(peerThreadId))
      .finally(() => setExtending((current) => (current === peerThreadId ? null : current))))
  }
  const extendButton = (peerThreadId: string, className?: string) => (
    <Button variant="ghost" size="sm" className={className} disabled={extending === peerThreadId} onClick={() => extend(peerThreadId)}>
      {extending === peerThreadId
        ? <><span aria-hidden className="mr-1 inline-block size-3 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none" />Extending</>
        : extended === peerThreadId ? 'Extended' : `Extend (+${PEER_LINK_EXTEND_MESSAGES})`}
    </Button>
  )
  const only = links.length === 1 ? links[0] : null

  return (
    <aside
      aria-label="Session links"
      data-testid="peer-link-banner"
      className="flex min-h-[32px] shrink-0 items-center gap-2 border-b border-[var(--border)] px-4 py-[3px] text-[11px] text-[var(--text-muted)]"
    >
      <span aria-hidden="true">⇄</span>
      <span className={`min-w-0 truncate transition-colors duration-500 ${extended ? 'text-[var(--accent)]' : ''}`} title={links.map((link) => peerLinkLabel(link, now)).join(', ')}>
        {peerLinksBannerText(links, now)}
      </span>
      {error && <span role="alert" className="min-w-0 truncate text-[var(--error)]" title={error}>{error}</span>}
      {only ? (
        <span className="ml-auto flex shrink-0 items-center">
          {extendButton(only.peerThreadId, 'text-[var(--accent)]')}
          <Button variant="ghost" size="sm" className="text-[var(--accent)]" onClick={() => unlink(only.peerThreadId)}>Unlink</Button>
        </span>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="ml-auto text-[var(--accent)]">Manage</Button>
          </PopoverTrigger>
          {/* Any number of links: the list scrolls rather than growing past the window. */}
          <PopoverContent align="end" className="sb-floating-surface z-[1200] w-[360px] overflow-hidden rounded-[8px] border border-[var(--border)] p-1 text-[12.5px] text-[var(--text-primary)]">
            <div className="max-h-[320px] overflow-y-auto">
              {links.map((link) => (
                <div key={link.peerThreadId} className="flex items-center gap-1 rounded-[6px] px-2 py-[2px]">
                  <span className="min-w-0 flex-1 truncate" title={peerLinkLabel(link, now)}>{peerLinkLabel(link, now)}</span>
                  {extendButton(link.peerThreadId)}
                  <Button variant="ghost" size="sm" onClick={() => unlink(link.peerThreadId)}>Unlink</Button>
                </div>
              ))}
            </div>
            <div className="mt-1 flex justify-end border-t border-[var(--border)] px-1 pt-1">
              <Button variant="ghost" size="sm" onClick={() => unlink()}>Unlink all</Button>
            </div>
          </PopoverContent>
        </Popover>
      )}
    </aside>
  )
}
