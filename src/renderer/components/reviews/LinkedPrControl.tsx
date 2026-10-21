/**
 * The chat header's linked pull requests: a chip ("2 open · 106 linked") that
 * opens a searchable list of every PR linked to the chat, open ones first.
 * A pick opens the PR in Reviews. PR state and titles come from the Reviews
 * list, read on the Reviews cadence (on open and on focus, never faster),
 * unless the backend read a newer state for the link (a merge in a shell).
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Command } from 'cmdk'
import type { PrLink } from '@shared/pull-request-links'
import { prRowStatus } from '@shared/pull-request-groups'
import { cn } from '../../lib/utils'
import { createRendererLogger } from '../../logger'
import { useLayoutStore } from '../../stores/layout-store'
import { useReviewStore } from '../../stores/review-store'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import {
  capLinkedPrRows,
  chipCounts,
  chipIconRow,
  filterLinkedPrRows,
  linkedPrRow,
  rowDetail,
  rowTitle,
  rowTooltip,
  sortLinkedPrRows,
  spansRepos,
  type LinkedPrRow,
} from './linked-pr-picker'
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

function statusIcon({ pr, state }: LinkedPrRow) {
  const status = pr ? prRowStatus(pr, Date.now()) : null
  if (status) return ROW_ICON[status.icon]
  if (state === 'merged') return ROW_ICON.merged
  return { name: 'pr' as const, tone: 'dim' as const, label: 'Pull request' }
}

/** A dot for open and draft PRs only; other rows keep the space so titles line up. */
function StateDot({ row }: { row: LinkedPrRow }) {
  const open = row.state === 'open'
  const draft = open && row.pr?.draft
  return (
    <span
      aria-hidden="true"
      className={cn(
        'size-[6px] shrink-0 rounded-full',
        draft ? 'border-[1.5px] border-solid border-[var(--text-muted)]' : open && 'bg-[var(--success)]',
      )}
    />
  )
}

export function LinkedPrControl({ sessionId }: { sessionId: string }) {
  const links = useChatLinks(sessionId)
  const list = useReviewStore((s) => s.list)
  const hasLinks = links.length > 0
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!hasLinks) return
    const refresh = useReviewStore.getState().refresh
    void refresh('open', { asHeader: true })
    const onFocus = () => void refresh('focus', { asHeader: true })
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [hasLinks])

  const rows = useMemo(() => sortLinkedPrRows(links.map((link) => linkedPrRow(link, list))), [links, list])
  const matches = useMemo(() => filterLinkedPrRows(rows, query), [rows, query])

  if (!hasLinks) return null
  const multiRepo = spansRepos(rows)
  const { shown, hidden } = capLinkedPrRows(matches, showAll)
  const counts = chipCounts(rows)
  const icon = statusIcon(chipIconRow(rows))

  const changeOpen = (next: boolean) => {
    if (!next) {
      setQuery('')
      setShowAll(false)
    }
    setOpen(next)
  }

  const search = (next: string) => {
    setQuery(next)
    setShowAll(false)
  }

  const openInReviews = (key: string) => {
    changeOpen(false)
    useReviewStore.getState().select(key)
    useLayoutStore.getState().setAppView('reviews')
  }

  // One keyed list, so expanding turns "Show N more" into the first hidden row
  // in place: a selected cmdk item that unmounts sends the selection back to
  // the first row.
  const items = shown.map((row) => (
    <Command.Item
      key={row.key}
      value={row.key}
      data-linked-pr-row={row.key}
      title={rowTooltip(row)}
      onSelect={() => openInReviews(row.key)}
      className="flex cursor-pointer items-center gap-2 rounded-[5px] px-2 py-[5px] data-[selected=true]:bg-[var(--bg-hover)]"
    >
      <StateDot row={row} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] text-[var(--text-primary)]">{rowTitle(row)}</div>
        <div className="truncate text-[11px] text-[var(--text-secondary)]">
          {rowDetail(row, multiRepo).map((part, i) => (
            <Fragment key={i}>
              {i > 0 && ' · '}
              <span className={cn(part.bad && 'text-[var(--error)]')}>{part.text}</span>
            </Fragment>
          ))}
        </div>
      </div>
    </Command.Item>
  ))
  if (hidden > 0) {
    const next = matches[shown.length]
    items.push(
      <Command.Item
        key={next.key}
        value={next.key}
        onSelect={() => setShowAll(true)}
        className="cursor-pointer rounded-[5px] px-2 py-[5px] text-[12px] text-[var(--text-secondary)] data-[selected=true]:bg-[var(--bg-hover)] data-[selected=true]:text-[var(--text-primary)]"
      >
        Show {hidden} more
      </Command.Item>,
    )
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-linked-pr
          data-status-tone={icon.tone}
          aria-label={`Linked pull requests: ${counts.open} open of ${counts.linked}`}
          // Gives way before the chat title (shrink-[1000] against the title's 1),
          // down to the open count; the linked count shows only in a wide header
          // and the whole control hides in a narrow one.
          className="inline-flex h-[20px] min-w-min shrink-[1000] overflow-hidden @max-[360px]:hidden cursor-pointer items-center gap-[6px] rounded-[6px] border border-[var(--border)] bg-[var(--bg-surface)] px-2 text-[11.5px] text-[var(--text-secondary)] hover:border-[var(--border-focus)]"
        >
          <Icon name={icon.name} tone={icon.tone} size={13} />
          <b className="shrink-0 font-[500] text-[var(--text-primary)]">{counts.open} open</b>
          <span className="hidden min-w-0 truncate @min-[760px]:inline">· {counts.linked} linked</span>
          <Icon name="chev" size={11} tone="dim" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Linked pull requests"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
        }}
        className="sb-floating-surface z-[1200] w-[340px] overflow-hidden rounded-[8px] border border-[var(--border)]"
      >
        <Command shouldFilter={false} loop label="Linked pull requests" className="outline-none">
          <Command.Input
            ref={inputRef}
            value={query}
            onValueChange={search}
            placeholder={`Search ${rows.length} linked pull request${rows.length === 1 ? '' : 's'}`}
            spellCheck={false}
            className="w-full border-0 border-b border-solid border-b-[var(--border)] bg-transparent px-3 py-2 text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />
          <Command.List className="max-h-[460px] overflow-y-auto p-1">
            <Command.Empty className="px-2 py-3 text-center text-[12px] text-[var(--text-muted)]">
              No matches.{' '}
              <button
                type="button"
                // cmdk's Enter handler would otherwise swallow the key.
                onKeyDown={(event) => event.stopPropagation()}
                onClick={() => {
                  search('')
                  inputRef.current?.focus()
                }}
                className="cursor-pointer border-0 bg-transparent p-0 text-[12px] text-[var(--text-secondary)] underline hover:text-[var(--text-primary)]"
              >
                Clear
              </button>
            </Command.Empty>
            {items}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
