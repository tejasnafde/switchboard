/**
 * Read-only unified diff for one changed file, with each review
 * conversation drawn under the line it is anchored to. Conversations whose
 * line is not in the shown hunks (outdated, or outside the context) are
 * listed after the diff so none disappears.
 */
import { useState, type MouseEvent } from 'react'
import type { DiffLine, PrChangedFile, PrConversation, PrSummary } from '@shared/pull-requests'
import { diffAround } from '@shared/review-context'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { shortAgo } from './review-states'
import { Avatar, Icon } from './review-ui'
import { askAgent } from './review-to-chat'
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

/** Lines picked by clicking the line numbers; shift-click extends on the same side. */
interface LineSelection {
  side: 'new' | 'old'
  anchor: number
  start: number
  end: number
}

function lineOn(line: DiffLine, side: 'new' | 'old'): number | null {
  return side === 'old' ? (line.kind !== 'add' ? line.oldLine : null) : (line.kind !== 'del' ? line.newLine : null)
}

function LineNumber({ n, shown, onPick }: { n: number | null; shown: number | null; onPick: (n: number, e: MouseEvent) => void }) {
  if (n === null) return <span className="pr-[10px] text-right text-[var(--text-muted)] select-none">{shown ?? ''}</span>
  return (
    <button
      type="button"
      onClick={(e) => onPick(n, e)}
      aria-label={`Select line ${n}`}
      title="Select line (shift-click for a range)"
      className="cursor-pointer border-none bg-transparent p-0 pr-[10px] text-right [font:inherit] text-[var(--text-muted)] select-none hover:text-[var(--text-primary)]"
    >
      {n}
    </button>
  )
}

export function PrDiff({ pr, file, conversations, now }: { pr: PrSummary; file: PrChangedFile; conversations: PrConversation[]; now: number }) {
  const [sel, setSel] = useState<LineSelection | null>(null)
  const pick = (side: 'new' | 'old', n: number, e: MouseEvent) => {
    setSel((prev) => {
      if (e.shiftKey && prev && prev.side === side) return { ...prev, start: Math.min(prev.anchor, n), end: Math.max(prev.anchor, n) }
      if (prev && prev.side === side && prev.start === n && prev.end === n) return null
      return { side, anchor: n, start: n, end: n }
    })
  }
  const selected = (line: DiffLine) => {
    if (!sel) return false
    const n = lineOn(line, sel.side)
    return n !== null && n >= sel.start && n <= sel.end
  }
  const ask = () => {
    if (!sel) return
    const diff = diffAround(file, sel.side, sel.start, sel.end, 0)
    if (!diff) return
    void askAgent({ pr: pr.ref, title: pr.title, url: pr.url, items: [{ kind: 'lines', path: file.path, side: sel.side, startLine: sel.start, endLine: sel.end, diff }] })
    setSel(null)
  }
  const placed = new Set<string>()
  const rows = file.hunks.flatMap((hunk, h) => [
    <div key={`h${h}`} className="bg-[var(--bg-tertiary)] px-[14px] py-[2px] text-[var(--text-muted)]">{hunk.header}</div>,
    ...hunk.lines.flatMap((line, i) => {
      const here = conversations.filter((c) => !placed.has(c.id) && anchoredTo(line, c))
      for (const c of here) placed.add(c.id)
      const isSel = selected(line)
      const lastSel = isSel && sel !== null && lineOn(line, sel.side) === sel.end
      return [
        <div
          key={`h${h}l${i}`}
          data-diff-line={line.kind}
          aria-selected={isSel || undefined}
          className={cn(
            'grid grid-cols-[48px_48px_18px_1fr] whitespace-pre',
            line.kind === 'add' && 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)]',
            line.kind === 'del' && 'bg-[color-mix(in_srgb,var(--error)_14%,transparent)]',
            isSel && 'bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] shadow-[inset_3px_0_0_var(--accent)]',
          )}
        >
          <LineNumber n={lineOn(line, 'old')} shown={line.oldLine} onPick={(n, e) => pick('old', n, e)} />
          <LineNumber n={lineOn(line, 'new')} shown={line.newLine} onPick={(n, e) => pick('new', n, e)} />
          <span className={cn('select-none', line.kind === 'context' ? 'text-[var(--text-muted)]' : line.kind === 'add' ? 'text-[var(--success)]' : 'text-[var(--error)]')}>
            {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
          </span>
          <span className="pr-[14px]">{line.text}</span>
        </div>,
        ...(lastSel ? [
          <div key={`h${h}l${i}sel`} className="relative h-0">
            <div className="absolute top-[2px] left-[114px] z-[3] flex gap-1 rounded-[8px] border border-[var(--border-strong,var(--border))] bg-[var(--bg-surface)] p-1 font-[family-name:var(--font-sans)] shadow-[0_8px_24px_rgba(0,0,0,0.4)]">
              <Button variant="outline" size="sm" onClick={ask}><Icon name="spark" />Ask the agent</Button>
            </div>
          </div>,
        ] : []),
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
