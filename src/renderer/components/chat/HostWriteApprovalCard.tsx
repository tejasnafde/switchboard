import { useRef, useState } from 'react'
import type { ChatMessage } from '@shared/types'
import { hostWriteTitle, type HostWriteResponse } from '@shared/agent-host-writes'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import { openExternal } from '../reviews/review-ui'
import { createRendererLogger } from '../../logger'
import { hostWriteButtons, hostWriteContext, hostWriteResponse, replyTextProblem, type HostWriteButton } from './host-write-card'

const log = createRendererLogger('chat:host-write-card')

interface HostWriteApprovalCardProps {
  message: ChatMessage
  onDecide: (requestId: string, decision: 'approve' | 'deny', note?: string, response?: HostWriteResponse) => void | Promise<void>
}

/**
 * The approval for a pull request write an agent asked for through the
 * Switchboard MCP server: who asked, the reviewer being answered, the reply
 * as an editable draft, and what it posts. The text left in the box is the
 * text that is posted.
 */
export function HostWriteApprovalCard({ message, onDecide }: HostWriteApprovalCardProps) {
  const card = message.approval?.hostWrite
  const [text, setText] = useState(card?.replyText ?? '')
  // `pending` flips only when request.closed round-trips; this stops a double post before then.
  const submitRef = useRef(false)
  const [submitting, setSubmitting] = useState<HostWriteButton['id'] | null>(null)

  if (!message.approval || !card) return null
  const reqId = message.id.replace('approval_', '')
  const status = message.approval.status
  const pending = status === 'pending'
  const buttons = hostWriteButtons(card)
  const problem = replyTextProblem(card, text)

  const choose = (button: HostWriteButton) => {
    if (submitRef.current) return
    if (button.decision === 'approve' && problem) return
    submitRef.current = true
    setSubmitting(button.id)
    const response = button.decision === 'approve' ? hostWriteResponse(card, button.id, text) : undefined
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
            {status === 'accepted' ? 'Approved' : 'Not posted'}
          </span>
        )}
      </div>

      <div className="px-3 py-2 text-[12px] text-[var(--text-secondary)]">
        <div className="font-[family-name:var(--font-mono)]">
          {card.url
            ? <button type="button" onClick={() => openExternal(card.url!)} className="cursor-pointer border-none bg-transparent p-0 text-left text-[var(--text-secondary)] hover:underline">{hostWriteContext(card)}</button>
            : hostWriteContext(card)}
        </div>
        {card.checkName && <div className="mt-1 text-[var(--text-primary)]">{card.checkName}</div>}
        {card.quote && (
          <div data-host-write-quote className="mt-1.5 whitespace-pre-wrap border-l-2 border-[var(--border)] pl-2.5 text-[var(--text-primary)]">
            <b>{card.quote.author}:</b> {card.quote.body}
          </div>
        )}
      </div>

      {card.action === 'reply' && (
        <div className="px-3 pb-2">
          <div className="mb-1 text-[11px] text-[var(--text-muted)]">{pending ? 'Reply, editable' : 'Reply'}</div>
          <textarea
            aria-label="Reply to post"
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
            className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12.5px] leading-[1.5] text-[var(--text-primary)] outline-none focus-visible:border-[var(--accent)]"
          />
          <div className="mt-1 flex text-[11px] text-[var(--text-muted)]">
            <span>Posted as you, ending with "via Switchboard".</span>
            {pending && problem && <span role="alert" className="ml-auto text-[var(--error)]">{problem}</span>}
          </div>
        </div>
      )}

      {pending && (
        <div className="flex items-center gap-2 border-t border-[var(--border)] px-3 py-2">
          <span className="mr-auto text-[11px] text-[var(--text-muted)]">{card.agentLabel} asked for this; Switchboard holds it until you choose.</span>
          {buttons.map((b) => (
            <Button
              key={b.id}
              size="sm"
              variant={b.primary ? 'default' : b.decision === 'deny' ? 'ghost' : 'outline'}
              disabled={submitting !== null || (b.decision === 'approve' && problem !== null)}
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
