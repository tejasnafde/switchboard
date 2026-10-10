/**
 * "Finish your review": a summary, Comment / Approve / Request changes (the
 * author gets Comment only, since no host lets you approve your own PR), and
 * the line comments held for the review. Submitting sends them together.
 */
import { useRef, useState, type ReactNode } from 'react'
import { REVIEW_EVENT_LABEL, reviewEventsFor, reviewSubmitProblem, type ReviewEvent } from '@shared/pull-request-writes'
import { prKey, type PrSummary } from '@shared/pull-requests'
import { useReviewStore, type PendingComment } from '../../stores/review-store'
import { Button } from '../ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'
import { cn } from '../../lib/utils'
import { useWriteAction, WriteError } from './review-writes'
import { Icon } from './review-ui'

const EMPTY: PendingComment[] = []

export function usePendingComments(pr: PrSummary): PendingComment[] {
  return useReviewStore((s) => s.pendingComments[prKey(pr.ref)] ?? EMPTY)
}

function where(c: PendingComment): string {
  const lines = c.startLine !== undefined ? `${c.startLine}-${c.line}` : String(c.line)
  return `${c.path}:${lines}${c.side === 'old' ? ' (old)' : ''}`
}

function ReviewForm({ pr, initialEvent, onDone }: { pr: PrSummary; initialEvent: ReviewEvent; onDone: () => void }) {
  const events = reviewEventsFor(pr.viewer)
  const [event, setEvent] = useState<ReviewEvent>(events.includes(initialEvent) ? initialEvent : 'comment')
  const [body, setBody] = useState('')
  const pending = usePendingComments(pr)
  const write = useWriteAction(pr.ref)
  const problem = reviewSubmitProblem(pr.ref.host, event, body, pending.length)

  const submit = async () => {
    if (problem || write.pending) return
    const comments = pending.map(({ id: _id, ...c }) => c)
    const result = await write.run('review', () =>
      window.api.pullRequests.submitReview(pr.ref, { event, body, comments }),
    )
    if (!result) return
    const store = useReviewStore.getState()
    if (result.ok) {
      store.dropPendingComments(pr.ref)
      onDone()
    } else if (result.error.postedComments) {
      store.dropPendingComments(pr.ref, result.error.postedComments)
    }
  }

  return (
    <form
      data-review-form
      aria-label="Finish your review"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      className="w-[420px] p-3 text-[13px]"
    >
      <div className="mb-2 font-[600]">Finish your review</div>
      <textarea
        data-review-summary
        aria-label="Review summary"
        placeholder="Summary (optional)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void submit()
          }
        }}
        className="min-h-[64px] w-full resize-y rounded-[7px] border border-[var(--border)] bg-[var(--bg-primary)] px-[10px] py-2 text-[13px] leading-[1.5] text-[var(--text-primary)] outline-none focus-visible:border-[var(--accent)]"
      />
      <div role="radiogroup" aria-label="Review type" className="my-[10px] grid gap-[6px]">
        {events.map((e) => (
          <label key={e} className="flex cursor-pointer items-center gap-2">
            <input type="radio" name="review-event" value={e} checked={event === e} onChange={() => setEvent(e)} />
            {REVIEW_EVENT_LABEL[e]}
          </label>
        ))}
      </div>
      <div className="mb-[10px]">
        <div className="mb-1 text-[12px] text-[var(--text-secondary)]">
          {pending.length === 0
            ? 'No pending comments. Select lines in Files to add one.'
            : pending.length === 1
              ? '1 pending comment'
              : `${pending.length} pending comments`}
        </div>
        {pending.length > 0 && (
          <ul className="m-0 max-h-[160px] list-none overflow-auto rounded-[7px] border border-[var(--border)] p-0">
            {pending.map((c) => (
              <li
                key={c.id}
                className="flex items-start gap-2 px-2 py-[6px] text-[12px] [&+&]:border-t [&+&]:border-[var(--border)]"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-[family-name:var(--font-mono)] text-[var(--text-secondary)]">
                    {where(c)}
                  </div>
                  <div className="truncate">{c.body}</div>
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove the pending comment on ${where(c)}`}
                  disabled={write.pending}
                  onClick={() => useReviewStore.getState().removePendingComment(pr.ref, c.id)}
                >
                  <Icon name="x" size={12} />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <WriteError error={write.error} className="mb-2" />
      <div className="flex items-center justify-end gap-2">
        <span className={cn('mr-auto min-w-0 truncate text-[12px] text-[var(--text-muted)]', !problem && 'invisible')}>
          {problem ?? '-'}
        </span>
        <Button variant="ghost" size="sm" onClick={onDone} disabled={write.pending}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          className="min-w-[112px]"
          disabled={!!problem || write.pending}
          aria-busy={write.pending || undefined}
        >
          {write.pending ? 'Submitting…' : 'Submit review'}
        </Button>
      </div>
    </form>
  )
}

/**
 * The review form as a popover anchored to `children` (the header's Review
 * split button, or the pending review bar). `open` and `event` are owned by
 * the caller so a menu can pick the event before the form opens.
 */
export function ReviewFormPopover({
  pr,
  open,
  event,
  onOpenChange,
  children,
}: {
  pr: PrSummary
  open: boolean
  event: ReviewEvent
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  const content = useRef<HTMLDivElement>(null)
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        ref={content}
        align="end"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          content.current?.querySelector<HTMLTextAreaElement>('[data-review-summary]')?.focus()
        }}
        className="sb-floating-surface z-[1200] rounded-[12px] border border-[var(--border-strong,var(--border))] shadow-[0_12px_30px_rgba(0,0,0,0.35)]"
      >
        <ReviewForm pr={pr} initialEvent={event} onDone={() => onOpenChange(false)} />
      </PopoverContent>
    </Popover>
  )
}

/** "Your pending review: N comments" above Files and Conversations, with the way to finish it. */
export function PendingReviewBar({ pr }: { pr: PrSummary }) {
  const pending = usePendingComments(pr)
  const [open, setOpen] = useState(false)
  if (pending.length === 0) return null
  return (
    <ReviewFormPopover pr={pr} open={open} event="comment" onOpenChange={setOpen}>
      <div
        data-pending-review
        className="flex items-center gap-[10px] border-b border-[var(--border)] bg-[var(--bg-surface)] px-[14px] py-[6px] text-[12.5px] text-[var(--text-secondary)]"
      >
        <Icon name="msg" tone="warn" />
        <span className="min-w-0 flex-1">
          Your pending review: {pending.length === 1 ? '1 comment' : `${pending.length} comments`}
        </span>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          Finish your review
        </Button>
      </div>
    </ReviewFormPopover>
  )
}
