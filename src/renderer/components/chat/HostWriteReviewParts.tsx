import type { HostWriteDiffLine, HostWriteReview } from '@shared/agent-host-writes'
import { lineLocation } from '@shared/pull-request-writes'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import type { ReviewDraftState } from './host-write-card'

const TEXTAREA =
  'w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 [font-family:inherit] text-[12.5px] leading-[1.5] text-[var(--text-primary)] outline-none focus-visible:border-[var(--accent)]'

/** The diff lines around the lines a comment covers, those marked. Wraps instead of scrolling sideways. */
export function DiffExcerpt({ lines }: { lines: HostWriteDiffLine[] }) {
  if (lines.length === 0) return null
  return (
    <div data-host-write-excerpt className="mt-1 overflow-hidden rounded-[4px] border border-[var(--border)] font-[family-name:var(--font-mono)] text-[11px] leading-[1.45]">
      {lines.map((l, i) => (
        <div
          key={i}
          className={cn(
            'flex gap-2 border-l-2 px-1.5',
            l.target ? 'border-[var(--accent)]' : 'border-transparent',
            l.kind === 'add' && 'bg-[var(--diff-add-bg,rgba(46,160,67,0.15))]',
            l.kind === 'del' && 'bg-[var(--diff-del-bg,rgba(248,81,73,0.15))]',
          )}
        >
          <span className="w-[4ch] shrink-0 text-right text-[var(--text-muted)] select-none">{l.kind === 'del' ? l.oldLine : l.newLine}</span>
          <span className="w-[1ch] shrink-0 text-[var(--text-muted)] select-none">{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}</span>
          <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-[var(--text-primary)]">{l.text || ' '}</span>
        </div>
      ))}
    </div>
  )
}

interface ReviewDraftFieldsProps {
  review: HostWriteReview
  draft: ReviewDraftState
  editable: boolean
  onChange(draft: ReviewDraftState): void
}

/**
 * The draft review in the card: the summary, then one compact row per inline
 * comment with its place, a short diff excerpt and its text. Remove keeps the
 * row (dimmed, with Restore), so nothing below it moves.
 */
export function ReviewDraftFields({ review, draft, editable, onChange }: ReviewDraftFieldsProps) {
  const setComment = (id: string, patch: Partial<ReviewDraftState['comments'][number]>) =>
    onChange({ ...draft, comments: draft.comments.map((c) => (c.id === id ? { ...c, ...patch } : c)) })
  const kept = draft.comments.filter((c) => !c.removed).length

  return (
    <div className="px-3 pb-2">
      <div className="mb-1 text-[11px] text-[var(--text-muted)]">{editable ? 'Summary, editable' : 'Summary'}</div>
      <textarea
        aria-label="Review summary"
        value={draft.summary}
        readOnly={!editable}
        onChange={(e) => onChange({ ...draft, summary: e.target.value })}
        rows={3}
        className={TEXTAREA}
      />
      {review.comments.length > 0 && (
        <div className="mt-2 mb-1 text-[11px] text-[var(--text-muted)]">
          {kept === review.comments.length ? `${kept} line comments` : `${kept} of ${review.comments.length} line comments kept`}
        </div>
      )}
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {review.comments.map((c) => {
          const state = draft.comments.find((d) => d.id === c.id)
          if (!state) return null
          const where = lineLocation(c)
          return (
            <li key={c.id} data-review-comment={c.id} data-removed={state.removed || undefined} className="rounded-md border border-[var(--border)] px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className={cn('min-w-0 flex-1 font-[family-name:var(--font-mono)] text-[11px] [overflow-wrap:anywhere] text-[var(--text-secondary)]', state.removed && 'line-through')}>{where}</span>
                {/* Stays after the decision, disabled, so the rows keep their height. */}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!editable}
                  aria-label={`${state.removed ? 'Restore' : 'Remove'} the comment on ${where}`}
                  onClick={() => setComment(c.id, { removed: !state.removed })}
                >
                  {state.removed ? 'Restore' : 'Remove'}
                </Button>
              </div>
              <div className={cn(state.removed && 'opacity-45')}>
                <DiffExcerpt lines={c.excerpt} />
                <textarea
                  aria-label={`Comment on ${where}`}
                  value={state.text}
                  readOnly={!editable || state.removed}
                  onChange={(e) => setComment(c.id, { text: e.target.value })}
                  rows={2}
                  className={cn(TEXTAREA, 'mt-1')}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
