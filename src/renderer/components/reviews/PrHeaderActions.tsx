/**
 * The header's split button: Merge on your own pull request, Review on one
 * you review. Both keep their place and size in every state: blocked,
 * loading and sending disable them instead of removing them. Beside it, the
 * ⋯ menu: Hide from Reviews (local) and Decline / Close (on the host, for
 * everyone, only where the host allows it).
 *
 * Merge uses a merge commit unless the user picks another strategy from the
 * menu, which lists only what the repository allows, merge commit first.
 * The pick lasts for this run of the app. Merging asks first, naming the
 * target branch and the strategy, and the backend re-reads the PR before it
 * merges.
 */
import { useState, type KeyboardEvent } from 'react'
import {
  effectiveMergeStrategy,
  MERGE_STRATEGY_LABEL,
  REVIEW_EVENT_LABEL,
  reviewEventsFor,
  type ReviewEvent,
} from '@shared/pull-request-writes'
import {
  HOST_CAPABILITIES,
  PR_HOST_LABEL,
  prKey,
  repoKey,
  type MergeStrategy,
  type PrDetail,
  type PrSummary,
} from '@shared/pull-requests'
import { useReviewStore } from '../../stores/review-store'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { confirm } from '../ui/confirm'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { usePrResource } from './PrDetailPane'
import { ReviewFormPopover } from './PrReviewForm'
import { declineConfirmCopy, mergeConfirmCopy } from './review-states'
import { Icon } from './review-ui'
import { useWriteAction, WriteError } from './review-writes'

const MENU =
  'sb-floating-surface z-[1200] min-w-[220px] rounded-[10px] border border-[var(--border-strong,var(--border))] p-1 shadow-[0_12px_30px_rgba(0,0,0,0.35)]'

function MenuItem({ checked, onSelect, children }: { checked: boolean; onSelect: () => void; children: string }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      onClick={onSelect}
      className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] border-none bg-transparent px-2 py-[6px] text-left text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] focus-visible:outline-none"
    >
      <span className={cn('w-[14px]', !checked && 'invisible')}>
        <Icon name="ok" size={12} />
      </span>
      {children}
    </button>
  )
}

/** Arrow keys move between the menu's items. */
function menuKeys(e: KeyboardEvent<HTMLDivElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  e.preventDefault()
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')]
  const at = items.indexOf(document.activeElement as HTMLButtonElement)
  items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
}

function focusChecked(e: Event) {
  e.preventDefault()
  const menu = e.currentTarget as HTMLElement
  ;(
    menu.querySelector<HTMLElement>('[aria-checked="true"]') ?? menu.querySelector<HTMLElement>('[role^="menuitem"]')
  )?.focus()
}

function mergeTitle(detail: PrDetail | null, strategy: MergeStrategy | null): string {
  if (!detail) return 'Loading the pull request…'
  if (detail.mergeBlockers.length > 0) return `Blocked: ${detail.mergeBlockers.map((b) => b.label).join(', ')}`
  if (!strategy) return 'This repository allows only squash or rebase. Pick one from the menu.'
  return `Merge with a ${MERGE_STRATEGY_LABEL[strategy].toLowerCase()}`
}

function MergeSplitButton({ pr, detail }: { pr: PrSummary; detail: PrDetail | null }) {
  const picked = useReviewStore((s) => s.mergeStrategy[repoKey(pr.ref)])
  const allowed = detail?.mergeStrategies ?? []
  const strategy = effectiveMergeStrategy(allowed, picked)
  const write = useWriteAction(pr.ref)
  const [menu, setMenu] = useState(false)
  const blocked = !detail || !detail.headSha || detail.mergeBlockers.length > 0
  const title = mergeTitle(detail, strategy)

  const merge = async () => {
    if (!detail?.headSha || !strategy || blocked) return
    if (!(await confirm(mergeConfirmCopy(detail, strategy)))) return
    const expectedHeadSha = detail.headSha
    await write.run('merge', () => window.api.pullRequests.merge(pr.ref, { strategy, expectedHeadSha }))
  }

  return (
    <div className="flex flex-col items-end">
      <div className="flex" data-merge-button>
        <Button
          size="sm"
          className="min-w-[92px] rounded-r-none"
          disabled={blocked || !strategy || write.pending}
          aria-busy={write.pending || undefined}
          title={title}
          onClick={() => void merge()}
        >
          <Icon name="merge" />
          {write.pending ? 'Merging…' : 'Merge'}
        </Button>
        <Popover open={menu} onOpenChange={setMenu}>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              className="rounded-l-none border-l border-l-[color-mix(in_srgb,var(--bg-primary)_45%,transparent)] px-[6px]"
              disabled={blocked || allowed.length === 0 || write.pending}
              aria-label="Merge strategy"
              aria-haspopup="menu"
              title={title}
            >
              <Icon name="chev" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className={MENU} onOpenAutoFocus={focusChecked}>
            <div role="menu" aria-label="Merge strategy" onKeyDown={menuKeys}>
              {allowed.map((s) => (
                <MenuItem
                  key={s}
                  checked={s === strategy}
                  onSelect={() => {
                    useReviewStore.getState().setMergeStrategy(pr.ref, s)
                    setMenu(false)
                  }}
                >
                  {MERGE_STRATEGY_LABEL[s]}
                </MenuItem>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <WriteError error={write.error} className="mt-1 max-w-[360px] text-right" />
    </div>
  )
}

function ReviewSplitButton({ pr, detail }: { pr: PrSummary; detail: PrDetail | null }) {
  const [view, setView] = useState<'closed' | 'menu' | 'form'>('closed')
  const [event, setEvent] = useState<ReviewEvent>('comment')
  // The detail read says who you are on this PR; until then only Comment is offered.
  const events = reviewEventsFor(detail?.viewer ?? { isAuthor: true })
  const reviewPr = detail ?? pr

  return (
    <ReviewFormPopover
      pr={reviewPr}
      open={view === 'form'}
      event={event}
      onOpenChange={(open) => setView(open ? 'form' : 'closed')}
    >
      <div className="flex" data-review-button>
        <Button size="sm" className="rounded-r-none" disabled={!detail} onClick={() => setView('form')}>
          Review
        </Button>
        <Popover open={view === 'menu'} onOpenChange={(open) => setView(open ? 'menu' : 'closed')}>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              className="rounded-l-none border-l border-l-[color-mix(in_srgb,var(--bg-primary)_45%,transparent)] px-[6px]"
              disabled={!detail}
              aria-label="Review type"
              aria-haspopup="menu"
            >
              <Icon name="chev" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className={MENU} onOpenAutoFocus={focusChecked}>
            <div role="menu" aria-label="Review type" onKeyDown={menuKeys}>
              {events.map((e) => (
                <MenuItem
                  key={e}
                  checked={e === event}
                  onSelect={() => {
                    setEvent(e)
                    setView('form')
                  }}
                >
                  {REVIEW_EVENT_LABEL[e]}
                </MenuItem>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </ReviewFormPopover>
  )
}

function ActionItem({
  onSelect,
  title,
  detail,
  danger,
}: {
  onSelect: () => void
  title: string
  detail: string
  danger?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className="block w-full cursor-pointer rounded-[6px] border-none bg-transparent px-2 py-[6px] text-left hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] focus-visible:outline-none"
    >
      <span className={cn('block text-[12.5px]', danger ? 'text-[var(--error)]' : 'text-[var(--text-primary)]')}>
        {title}
      </span>
      <span className="block text-[11.5px] text-[var(--text-muted)]">{detail}</span>
    </button>
  )
}

function focusFirst(e: Event) {
  e.preventDefault()
  ;(e.currentTarget as HTMLElement).querySelector<HTMLElement>('[role="menuitem"]')?.focus()
}

function PrMoreMenu({ pr, detail }: { pr: PrSummary; detail: PrDetail | null }) {
  const [open, setOpen] = useState(false)
  const [hideError, setHideError] = useState<string | null>(null)
  const hidden = useReviewStore((s) => s.list?.hidden?.includes(prKey(pr.ref)) ?? false)
  const write = useWriteAction(pr.ref)
  const verb = HOST_CAPABILITIES[pr.ref.host].declineLabel
  const canDecline = pr.state === 'open' && !!detail?.viewerCanManage

  const toggleHidden = async () => {
    setOpen(false)
    setHideError(await useReviewStore.getState().setHidden(pr.ref, !hidden))
  }

  const decline = async () => {
    setOpen(false)
    if (!(await confirm(declineConfirmCopy(pr)))) return
    await write.run('decline', () => window.api.pullRequests.decline(pr.ref))
  }

  return (
    <div className="flex flex-col items-end">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="px-[6px]"
            aria-label="More actions"
            aria-haspopup="menu"
            disabled={write.pending}
          >
            <Icon name="more" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className={cn(MENU, 'w-[280px]')} onOpenAutoFocus={focusFirst}>
          <div role="menu" aria-label="More actions" onKeyDown={menuKeys}>
            {hidden ? (
              <ActionItem
                onSelect={() => void toggleHidden()}
                title="Show in Reviews"
                detail="Lists it again with the others."
              />
            ) : (
              <ActionItem
                onSelect={() => void toggleHidden()}
                title="Hide from Reviews"
                detail="Only in Switchboard. It comes back when it changes and needs you."
              />
            )}
            {canDecline && (
              <ActionItem
                danger
                onSelect={() => void decline()}
                title={`${verb} pull request…`}
                detail={`On ${PR_HOST_LABEL[pr.ref.host]}, for everyone. Asks to confirm.`}
              />
            )}
          </div>
        </PopoverContent>
      </Popover>
      {hideError && (
        <div role="alert" className="mt-1 max-w-[260px] text-right text-[12px] text-[var(--error)]">
          {hideError}
        </div>
      )}
      <WriteError error={write.error} className="mt-1 max-w-[260px] text-right" />
    </div>
  )
}

/** Merge for the author and Review for everyone else on an open PR, then the ⋯ menu. */
export function PrHeaderActions({ pr }: { pr: PrSummary }) {
  const { value } = usePrResource(pr, 'detail')
  const detail = value?.status === 'ok' ? value.data : null
  return (
    <>
      {pr.state === 'open' &&
        (pr.viewer.isAuthor ? (
          <MergeSplitButton pr={pr} detail={detail} />
        ) : (
          <ReviewSplitButton pr={pr} detail={detail} />
        ))}
      <PrMoreMenu pr={pr} detail={detail} />
    </>
  )
}
