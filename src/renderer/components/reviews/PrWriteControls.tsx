/**
 * The smaller write controls: a thread's reply box and Resolve, the box a
 * diff selection opens for a line comment (now, or held for the review), a
 * pending comment in the diff, the comment box on the whole PR, and Re-run
 * on a failed check. Each keeps its size while sending; only Resolve
 * changes before the host answers.
 */
import { useState, type KeyboardEvent } from 'react'
import type { PrCheck, PrConversation, PrError, PrSummary } from '@shared/pull-requests'
import type { InlineCommentInput } from '@shared/pull-request-writes'
import { useReviewStore, type PendingComment } from '../../stores/review-store'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { rerunUnavailable } from './review-states'
import { Icon } from './review-ui'
import { toggleResolved, useWriteAction, WriteError } from './review-writes'

const FIELD = 'w-full resize-y rounded-[7px] border border-[var(--border)] bg-[var(--bg-primary)] px-[10px] py-[6px] font-[family-name:var(--font-sans)] text-[13px] leading-[1.5] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus-visible:border-[var(--accent)]'

/** ⌘Enter (Ctrl+Enter) sends from any of these boxes; Enter alone is a new line. */
function sendKeys(send: () => void) {
  return (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      send()
    }
  }
}

export function ThreadFooter({ pr, conversation }: { pr: PrSummary; conversation: PrConversation }) {
  const [text, setText] = useState('')
  const reply = useWriteAction(pr.ref)
  const [resolving, setResolving] = useState(false)
  const [resolveError, setResolveError] = useState<PrError | null>(null)

  const send = async () => {
    if (!text.trim() || reply.pending) return
    const result = await reply.run('reply', () => window.api.pullRequests.reply(pr.ref, { conversationId: conversation.id, body: text }))
    if (result?.ok) setText('')
  }
  const resolve = async () => {
    if (resolving) return
    setResolving(true)
    setResolveError(null)
    setResolveError(await toggleResolved(pr.ref, conversation))
    setResolving(false)
  }

  return (
    <div data-thread-footer className="border-t border-[var(--border)] px-3 py-2">
      <div className="flex items-start gap-2">
        <textarea
          rows={1}
          aria-label={`Reply to the conversation on ${conversation.path ?? 'the pull request'}`}
          placeholder="Reply"
          value={text}
          disabled={reply.pending}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={sendKeys(() => void send())}
          className={cn(FIELD, 'max-h-[160px] min-h-7 resize-none py-[3px] leading-[20px] [field-sizing:content]')}
        />
        <Button variant="outline" size="sm" className="min-w-[76px]" disabled={!text.trim() || reply.pending} aria-busy={reply.pending || undefined} onClick={() => void send()}>
          {reply.pending ? 'Sending…' : 'Reply'}
        </Button>
        <Button variant="outline" size="sm" className="min-w-[82px]" disabled={resolving} onClick={() => void resolve()}>
          {conversation.resolved ? 'Unresolve' : 'Resolve'}
        </Button>
      </div>
      <WriteError error={reply.error ?? resolveError} className="mt-1" />
    </div>
  )
}

/** Opened from a diff selection: post the comment now, or hold it for the review. */
export function LineCommentBox({ pr, target, onClose }: { pr: PrSummary; target: Omit<InlineCommentInput, 'body'>; onClose: () => void }) {
  const [text, setText] = useState('')
  const write = useWriteAction(pr.ref)
  const body = text.trim()
  const lines = target.startLine !== undefined ? `lines ${target.startLine}-${target.line}` : `line ${target.line}`

  const now = async () => {
    if (!body || write.pending) return
    const result = await write.run('inline comment', () => window.api.pullRequests.inlineComment(pr.ref, { ...target, body }))
    if (result?.ok) onClose()
  }
  const hold = () => {
    if (!body) return
    useReviewStore.getState().addPendingComment(pr.ref, { ...target, body })
    onClose()
  }

  return (
    <div data-line-comment className="mt-2 mr-4 mb-3 ml-[114px] rounded-[10px] border border-[var(--border)] bg-[var(--bg-surface)] p-3 font-[family-name:var(--font-sans)] whitespace-normal">
      <div className="mb-[6px] text-[12px] text-[var(--text-secondary)]">Comment on {lines}</div>
      <textarea
        autoFocus
        aria-label={`Comment on ${lines}`}
        placeholder="Leave a comment"
        value={text}
        disabled={write.pending}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          else sendKeys(hold)(e)
        }}
        className={cn(FIELD, 'min-h-[60px]')}
      />
      <WriteError error={write.error} className="mt-1" />
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={write.pending} onClick={onClose}>Cancel</Button>
        <Button variant="outline" size="sm" className="min-w-[112px]" disabled={!body || write.pending} aria-busy={write.pending || undefined} onClick={() => void now()}>
          {write.pending ? 'Commenting…' : 'Comment now'}
        </Button>
        <Button size="sm" disabled={!body || write.pending} onClick={hold}>Add to review</Button>
      </div>
    </div>
  )
}

export function PendingCommentCard({ pr, comment }: { pr: PrSummary; comment: PendingComment }) {
  return (
    <div data-pending-comment className="mt-2 mr-4 mb-3 ml-[114px] flex items-start gap-[10px] rounded-[10px] border border-dashed border-[var(--border-strong,var(--border))] bg-[var(--bg-surface)] px-3 py-[10px] font-[family-name:var(--font-sans)] text-[13px] leading-[1.5] whitespace-pre-wrap">
      <div className="min-w-0 flex-1">
        <span className="text-[12px] text-[var(--text-muted)]">Pending, in your review</span>
        <div>{comment.body}</div>
      </div>
      <Button variant="ghost" size="sm" onClick={() => useReviewStore.getState().removePendingComment(pr.ref, comment.id)}>Remove</Button>
    </div>
  )
}

/** A comment on the whole pull request, under Activity. */
export function PrCommentBox({ pr }: { pr: PrSummary }) {
  const [text, setText] = useState('')
  const write = useWriteAction(pr.ref)
  const send = async () => {
    if (!text.trim() || write.pending) return
    const result = await write.run('comment', () => window.api.pullRequests.comment(pr.ref, { body: text }))
    if (result?.ok) setText('')
  }
  return (
    <div data-pr-comment className="mt-3">
      <textarea
        aria-label="Comment on the pull request"
        placeholder="Comment on the pull request"
        value={text}
        disabled={write.pending}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={sendKeys(() => void send())}
        className={cn(FIELD, 'min-h-[60px] max-w-[640px]')}
      />
      <div className="mt-[6px] flex max-w-[640px] items-start gap-2">
        <WriteError error={write.error} className="min-w-0 flex-1" />
        <Button variant="outline" size="sm" className="ml-auto min-w-[104px]" disabled={!text.trim() || write.pending} aria-busy={write.pending || undefined} onClick={() => void send()}>
          {write.pending ? 'Commenting…' : 'Comment'}
        </Button>
      </div>
    </div>
  )
}

/** Re-run on a failed check that can re-run; the check reads "running" once the host has it. */
export function RerunButton({ pr, check }: { pr: PrSummary; check: PrCheck }) {
  const write = useWriteAction(pr.ref)
  const [requested, setRequested] = useState(false)
  if (check.state !== 'failure' || rerunUnavailable(pr, check)) return null
  const run = async () => {
    const result = await write.run('rerun', () => window.api.pullRequests.rerunCheck(pr.ref, { checkId: check.id }))
    if (result?.ok) setRequested(true)
  }
  const label = write.pending ? 'Re-running…' : requested ? 'Requested' : write.error ? 'Retry' : 'Re-run'
  return (
    <Button
      variant="ghost"
      size="sm"
      className="min-w-[88px]"
      disabled={write.pending || requested}
      aria-busy={write.pending || undefined}
      aria-label={`Re-run ${check.name}`}
      title={write.error?.message ?? `Re-run the failed jobs of ${check.name}`}
      onClick={() => void run()}
    >
      <Icon name="rerun" />{label}
    </Button>
  )
}
