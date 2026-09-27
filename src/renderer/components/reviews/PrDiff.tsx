/**
 * Read-only unified diff for one changed file, with each review
 * conversation drawn under the line it is anchored to. Conversations whose
 * line is not in the shown hunks (outdated, or outside the context) are
 * listed after the diff so none disappears.
 */
import type { DiffLine, PrChangedFile, PrConversation } from '@shared/pull-requests'
import { cn } from '../../lib/utils'
import { shortAgo } from './review-states'
import { Avatar } from './review-ui'
import { MarkdownWithCopyControls } from '../chat/MarkdownWithCopyControls'

function anchoredTo(line: DiffLine, c: PrConversation): boolean {
  if (c.line === null) return false
  return c.side === 'old' ? line.oldLine === c.line && line.kind !== 'add' : line.newLine === c.line && line.kind !== 'del'
}

export function ConversationThread({ conversation, now, className, markResolved = true }: { conversation: PrConversation; now: number; className?: string; markResolved?: boolean }) {
  return (
    <div data-pr-thread={conversation.id} className={cn('overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--bg-surface)] font-[family-name:var(--font-sans)] text-[13px] leading-[1.5] whitespace-normal', className)}>
      {conversation.comments.map((c) => (
        <div key={c.id} className="grid grid-cols-[22px_1fr] gap-[10px] px-3 py-[10px] [&+&]:border-t [&+&]:border-[var(--border)]">
          <Avatar person={c.author} />
          <div className="min-w-0">
            <span className="font-[600]">{c.author.displayName}</span>
            <span className="ml-[6px] text-[12px] text-[var(--text-muted)]">{shortAgo(c.createdAt, now)}</span>
            <MarkdownWithCopyControls markdown={c.body} className="markdown-content" />
          </div>
        </div>
      ))}
      {markResolved && conversation.resolved && <div className="border-t border-[var(--border)] px-3 py-[6px] text-[12px] text-[var(--text-muted)]">Resolved</div>}
    </div>
  )
}

export function PrDiff({ file, conversations, now }: { file: PrChangedFile; conversations: PrConversation[]; now: number }) {
  const placed = new Set<string>()
  const rows = file.hunks.flatMap((hunk, h) => [
    <div key={`h${h}`} className="bg-[var(--bg-tertiary)] px-[14px] py-[2px] text-[var(--text-muted)]">{hunk.header}</div>,
    ...hunk.lines.flatMap((line, i) => {
      const here = conversations.filter((c) => !placed.has(c.id) && anchoredTo(line, c))
      for (const c of here) placed.add(c.id)
      return [
        <div
          key={`h${h}l${i}`}
          data-diff-line={line.kind}
          className={cn(
            'grid grid-cols-[48px_48px_18px_1fr] whitespace-pre',
            line.kind === 'add' && 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)]',
            line.kind === 'del' && 'bg-[color-mix(in_srgb,var(--error)_14%,transparent)]',
          )}
        >
          <span className="pr-[10px] text-right text-[var(--text-muted)] select-none">{line.oldLine ?? ''}</span>
          <span className="pr-[10px] text-right text-[var(--text-muted)] select-none">{line.newLine ?? ''}</span>
          <span className={cn('select-none', line.kind === 'context' ? 'text-[var(--text-muted)]' : line.kind === 'add' ? 'text-[var(--success)]' : 'text-[var(--error)]')}>
            {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
          </span>
          <span className="pr-[14px]">{line.text}</span>
        </div>,
        ...here.map((c) => <ConversationThread key={c.id} conversation={c} now={now} className="mt-2 mr-4 mb-3 ml-[114px]" />),
      ]
    }),
  ])
  const unplaced = conversations.filter((c) => !placed.has(c.id))

  return (
    <div>
      {file.binary && <div className="px-[14px] py-3 text-[12.5px] text-[var(--text-muted)]">Binary file, not shown.</div>}
      {!file.binary && file.hunks.length === 0 && (
        <div className="px-[14px] py-3 text-[12.5px] text-[var(--text-muted)]">
          {file.truncated ? 'This diff is too large to show here. Open the pull request on the host to see it.' : 'No changes to show.'}
        </div>
      )}
      <div className="font-[family-name:var(--font-mono)] text-[12px] leading-[20px]">{rows}</div>
      {file.truncated && file.hunks.length > 0 && (
        <div className="px-[14px] py-2 text-[12px] text-[var(--text-muted)]">The rest of this diff is on the host.</div>
      )}
      {unplaced.length > 0 && (
        <div className="px-4 pt-3 pb-4">
          <div className="mb-2 text-[12px] text-[var(--text-muted)]">Conversations not on a shown line</div>
          {unplaced.map((c) => <ConversationThread key={c.id} conversation={c} now={now} className="mb-3" />)}
        </div>
      )}
    </div>
  )
}
