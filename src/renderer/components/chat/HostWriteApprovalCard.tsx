import { useRef, useState } from 'react'
import type { ChatMessage } from '@shared/types'
import { hostWriteTitle, type HostWriteResponse } from '@shared/agent-host-writes'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import { openExternal } from '../reviews/review-ui'
import { createRendererLogger } from '../../logger'
import {
  createDraftProblem,
  hostWriteButtons,
  hostWriteContext,
  hostWriteResponse,
  initialCreateDraft,
  initialReviewDraft,
  replyTextProblem,
  reviewButtonProblem,
  type CreateDraftState,
  type HostWriteButton,
  type ReviewDraftState,
} from './host-write-card'
import { CreatePrFields, DiffExcerpt, ReviewDraftFields } from './HostWriteReviewParts'

const log = createRendererLogger('chat:host-write-card')

interface HostWriteApprovalCardProps {
  message: ChatMessage
  onDecide: (requestId: string, decision: 'approve' | 'deny', note?: string, response?: HostWriteResponse) => void | Promise<void>
}

/**
 * The approval for a pull request write an agent asked for through the
 * Switchboard MCP server: who asked, the reviewer being answered, the diff
 * lines being commented on or the branches a new pull request merges, the
 * text as an editable draft, and what it posts.
 * The text left in the boxes is the text that is posted. A draft review ends
 * in one button per verdict the user may give, none of them preselected.
 */
export function HostWriteApprovalCard({ message, onDecide }: HostWriteApprovalCardProps) {
  const card = message.approval?.hostWrite
  const [text, setText] = useState(card?.replyText ?? '')
  const [draft, setDraft] = useState<ReviewDraftState>(() => initialReviewDraft(card?.review))
  const [create, setCreate] = useState<CreateDraftState>(() => initialCreateDraft(card))
  // `pending` flips only when request.closed round-trips; this stops a double post before then.
  const submitRef = useRef(false)
  const [submitting, setSubmitting] = useState<HostWriteButton['id'] | null>(null)

  if (!message.approval || !card) return null
  const reqId = message.id.replace('approval_', '')
  const status = message.approval.status
  const pending = status === 'pending'
  const buttons = hostWriteButtons(card)
  const problem = card.action === 'create' ? createDraftProblem(create) : replyTextProblem(card, text)
  const buttonProblem = (b: HostWriteButton): string | null => {
    if (b.decision !== 'approve') return null
    return b.verdict ? reviewButtonProblem(card, b.verdict, draft) : problem
  }
  // A review shows why its mildest verdict is off; a stricter one says why in its tooltip.
  const mildest = buttons.find((b) => b.verdict)
  const shownProblem = card.action === 'review' ? (mildest ? buttonProblem(mildest) : null) : problem

  const choose = (button: HostWriteButton) => {
    if (submitRef.current) return
    if (buttonProblem(button)) return
    submitRef.current = true
    setSubmitting(button.id)
    const response = button.decision === 'approve' ? hostWriteResponse(card, button, text, draft, create) : undefined
    Promise.resolve(onDecide(reqId, button.decision, undefined, response)).catch((err) => {
      // ChatPanel already put the failure in the chat; let the user try again.
      log.warn('decision failed, re-enabling card', { reqId, button: button.id, err })
      submitRef.current = false
      setSubmitting(null)
    })
  }
  const primary = buttons.find((b) => b.primary)

  return (
    <div
      data-host-write-card={card.action}
      data-status={status}
      className={cn(
        'mt-2 overflow-hidden rounded-md border',
        pending ? 'border-[var(--warning)]' : 'border-[var(--border)]',
      )}
    >
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <span className="text-[13px] font-[600] text-[var(--text-primary)]">{hostWriteTitle(card)}</span>
        {!pending && (
          <span className={cn('ml-auto text-[11px] font-[600] uppercase', status === 'accepted' ? 'text-[var(--success)]' : 'text-[var(--error)]')}>
            {status === 'accepted' ? (card.action === 'review' ? 'Submitted' : 'Approved') : card.action === 'create' ? 'Not opened' : 'Not posted'}
          </span>
        )}
      </div>

      <div className="px-3 py-2 text-[12px] text-[var(--text-secondary)]">
        <div className="font-[family-name:var(--font-mono)] [overflow-wrap:anywhere]">
          {card.url
            ? <button type="button" onClick={() => openExternal(card.url!)} className="cursor-pointer border-none bg-transparent p-0 text-left text-[var(--text-secondary)] hover:underline">{hostWriteContext(card)}</button>
            : hostWriteContext(card)}
        </div>
        {card.checkName && <div className="mt-1 text-[var(--text-primary)]">{card.checkName}</div>}
        {card.quote && (
          <div data-host-write-quote className="mt-1.5 whitespace-pre-wrap [overflow-wrap:anywhere] border-l-2 border-[var(--border)] pl-2.5 text-[var(--text-primary)]">
            <b>{card.quote.author}:</b> {card.quote.body}
          </div>
        )}
        {card.excerpt && <DiffExcerpt lines={card.excerpt} />}
      </div>

      {card.action === 'review' && card.review && (
        <>
          <ReviewDraftFields review={card.review} draft={draft} editable={pending && submitting === null} onChange={setDraft} />
          <div className="flex flex-wrap gap-x-2 px-3 pb-2 text-[11px] text-[var(--text-muted)]">
            <span>
              Posted as you, the summary and each comment ending with "via Switchboard". You pick the verdict.
              {card.review.commentOnly === 'author' && ' You wrote this pull request, so only Comment is offered.'}
              {card.review.commentOnly === 'closed' && ' This pull request is not open, so only Comment is offered.'}
            </span>
            {pending && shownProblem && <span role="alert" className="ml-auto text-[var(--error)]">{shownProblem}</span>}
          </div>
        </>
      )}

      {card.action === 'create' && card.create && (
        <>
          <CreatePrFields
            create={card.create}
            draft={create}
            editable={pending && submitting === null}
            onChange={setCreate}
            onSubmit={() => primary && choose(primary)}
          />
          <div className="flex flex-wrap gap-x-2 px-3 pb-2 text-[11px] text-[var(--text-muted)]">
            <span>Opened as you, the description ending with "via Switchboard", and linked to this chat.</span>
            {pending && problem && <span role="alert" className="ml-auto text-[var(--error)]">{problem}</span>}
          </div>
        </>
      )}

      {(card.action === 'reply' || card.action === 'comment') && (
        <div className="px-3 pb-2">
          <div className="mb-1 text-[11px] text-[var(--text-muted)]">{card.action === 'comment' ? (pending ? 'Comment, editable' : 'Comment') : (pending ? 'Reply, editable' : 'Reply')}</div>
          <textarea
            aria-label={card.action === 'comment' ? 'Comment to post' : 'Reply to post'}
            value={text}
            readOnly={!pending || submitting !== null}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && primary) {
                e.preventDefault()
                choose(primary)
              }
            }}
            rows={3}
            className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 [font-family:inherit] text-[12.5px] leading-[1.5] text-[var(--text-primary)] outline-none focus-visible:border-[var(--accent)]"
          />
          <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-[var(--text-muted)]">
            <span>Posted as you, ending with "via Switchboard".</span>
            {pending && problem && <span role="alert" className="ml-auto text-[var(--error)]">{problem}</span>}
          </div>
        </div>
      )}

      {pending && (
        <div data-host-write-actions className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--border)] px-3 py-2">
          {/* Shares the row when there is room, takes its own line in a narrow chat. */}
          <span className="mr-auto min-w-0 flex-[1_1_14rem] text-[11px] text-[var(--text-muted)]">{card.agentLabel} asked for this; Switchboard holds it until you choose.</span>
          {buttons.map((b) => (
            <Button
              key={b.id}
              size="sm"
              variant={b.primary ? 'default' : b.decision === 'deny' ? 'ghost' : 'outline'}
              disabled={submitting !== null || buttonProblem(b) !== null}
              title={buttonProblem(b) ?? undefined}
              aria-busy={submitting === b.id || undefined}
              onClick={() => choose(b)}
            >
              {b.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
