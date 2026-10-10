/**
 * The chat header's linked pull request: one compact control ("#612 build
 * failed · 3 open conversations") that opens a popover listing every linked
 * PR, how it was linked and "Open in Reviews". PR state comes from the
 * Reviews list, read on the Reviews cadence (on open and on focus, never
 * faster), unless the backend read a newer one for the link (a merge in a shell).
 */
import { useEffect, useState } from 'react'
import { linkHeaderState, linkSourceLabel, linkedPrPhrase, type PrLink } from '@shared/pull-request-links'
import { prRowStatus } from '@shared/pull-request-groups'
import { prKey, type PrListData, type PrState, type PrSummary } from '@shared/pull-requests'
import { createRendererLogger } from '../../logger'
import { useLayoutStore } from '../../stores/layout-store'
import { findSummary, useReviewStore } from '../../stores/review-store'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Icon, ROW_ICON } from './review-ui'

const log = createRendererLogger('reviews:chat-header')

function useChatLinks(sessionId: string): PrLink[] {
  const [links, setLinks] = useState<PrLink[]>([])
  useEffect(() => {
    let live = true
    const load = () =>
      window.api.pullRequests
        .links(sessionId)
        .then((next) => {
          if (live) setLinks(next)
        })
        .catch((err) => log.warn('reading linked pull requests failed', err))
    void load()
    const stop = window.api.pullRequests.onLinksChanged(() => void load())
    return () => {
      live = false
      stop()
    }
  }, [sessionId])
  return links
}

/** The list's summary with the link's newer state over it; `state` alone when the list lacks the PR. */
function linkRow(link: PrLink, list: PrListData | null): { link: PrLink; pr: PrSummary | null; state: PrState | null } {
  const listed = findSummary(list, prKey(link.ref))
  const state = linkHeaderState(link, listed?.state ?? null, list?.fetchedAt ?? null)
  const pr =
    listed && state && state !== listed.state
      ? { ...listed, state, mergedAt: listed.mergedAt ?? link.stateAt ?? null }
      : listed
  return { link, pr, state }
}

function rowPhrase({ pr, state }: { pr: PrSummary | null; state: PrState | null }): string {
  if (pr) return linkedPrPhrase(pr)
  return state && state !== 'open' ? state : ''
}

function PrStatusIcon({ pr, state }: { pr: PrSummary | null; state: PrState | null }) {
  const status = pr ? prRowStatus(pr, Date.now()) : null
  const icon = status
    ? ROW_ICON[status.icon]
    : state === 'merged'
      ? ROW_ICON.merged
      : { name: 'pr' as const, tone: 'dim' as const, label: 'Pull request' }
  return <Icon name={icon.name} tone={icon.tone} size={13} />
}

export function LinkedPrControl({ sessionId }: { sessionId: string }) {
  const links = useChatLinks(sessionId)
  const list = useReviewStore((s) => s.list)
  const hasLinks = links.length > 0
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!hasLinks) return
    const refresh = useReviewStore.getState().refresh
    void refresh('open', { asHeader: true })
    const onFocus = () => void refresh('focus', { asHeader: true })
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [hasLinks])

  if (!hasLinks) return null
  const rows = links.map((link) => linkRow(link, list))
  const first = rows[0]
  const phrase = rowPhrase(first)

  const openInReviews = (key: string) => {
    setOpen(false)
    useReviewStore.getState().select(key)
    useLayoutStore.getState().setAppView('reviews')
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-linked-pr
          aria-label={`Linked pull request #${first.link.ref.number}${phrase ? `, ${phrase}` : ''}`}
          title={phrase ? `#${first.link.ref.number} ${phrase}` : undefined}
          // Gives way before the chat title (shrink-[1000] against the title's 1),
          // down to icon + number; the phrase shows only in a wide header and
          // the whole control hides in a narrow one.
          className="inline-flex h-[20px] min-w-min shrink-[1000] overflow-hidden @max-[360px]:hidden cursor-pointer items-center gap-[6px] rounded-[6px] border border-[var(--border)] bg-[var(--bg-surface)] px-2 text-[11.5px] text-[var(--text-secondary)] hover:border-[var(--border-focus)]"
        >
          <PrStatusIcon pr={first.pr} state={first.state} />
          <b className="shrink-0 font-[500] text-[var(--text-primary)]">#{first.link.ref.number}</b>
          {phrase && <span className="hidden min-w-0 truncate @min-[760px]:inline">{phrase}</span>}
          {rows.length > 1 && <span className="text-[var(--text-muted)]">+{rows.length - 1}</span>}
          <Icon name="chev" size={11} tone="dim" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="sb-floating-surface z-[1200] w-[340px] overflow-hidden rounded-[8px] border border-[var(--border)] p-1 text-[12.5px] text-[var(--text-primary)]"
      >
        {rows.map((row) => {
          const { link, pr } = row
          const key = prKey(link.ref)
          const detail = [rowPhrase(row), linkSourceLabel(link.source)].filter(Boolean).join(' · ')
          return (
            <div key={key} className="flex items-center gap-2 rounded-[6px] px-2 py-[6px]">
              <PrStatusIcon pr={pr} state={row.state} />
              <div className="min-w-0 flex-1">
                <div className="truncate">
                  <b className="font-[500]">#{link.ref.number}</b> {pr?.title ?? `${link.ref.owner}/${link.ref.name}`}
                </div>
                <div className="truncate text-[12px] text-[var(--text-secondary)]">{detail}</div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => openInReviews(key)}>
                Open in Reviews
              </Button>
            </div>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
