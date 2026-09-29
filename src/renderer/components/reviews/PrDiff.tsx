/**
 * Unified diff for one changed file, with each review conversation (and its
 * reply box and Resolve) drawn under the line it is anchored to, and the
 * line comments held for your review. Lines picked by their numbers offer
 * Comment and Ask the agent. Conversations whose line is not in the shown
 * hunks (outdated, or outside the context) are listed after the diff so
 * none disappears.
 */
import { useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import type { DiffLine, PrChangedFile, PrConversation, PrSummary } from '@shared/pull-requests'
import { diffAround } from '@shared/review-context'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { shortAgo } from './review-states'
import { Avatar, Icon } from './review-ui'
import { askAgent } from './review-to-chat'
import { MarkdownWithCopyControls } from '../chat/MarkdownWithCopyControls'
import { usePendingComments } from './PrReviewForm'
import { LineCommentBox, PendingCommentCard, ThreadFooter } from './PrWriteControls'
import { afterDrag, dragLineSelection, lineOn, nextLineSelection, type LineSelection } from './line-selection'
import type { PendingComment } from '../../stores/review-store'

function anchoredTo(line: DiffLine, c: PrConversation): boolean {
  if (c.line === null) return false
  return c.side === 'old' ? line.oldLine === c.line && line.kind !== 'add' : line.newLine === c.line && line.kind !== 'del'
}

/** `pr` adds the reply box and Resolve under the comments; `showRange` names the lines of a multi-line thread, drawn under its last line. */
export function ConversationThread({ conversation, now, className, markResolved = true, pr, showRange = false }: { conversation: PrConversation; now: number; className?: string; markResolved?: boolean; pr?: PrSummary; showRange?: boolean }) {
  return (
    <div data-pr-thread={conversation.id} className={cn('overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--bg-surface)] font-[family-name:var(--font-sans)] text-[13px] leading-[1.5] whitespace-normal', className)}>
      {showRange && conversation.startLine !== undefined && (
        <div className="border-b border-[var(--border)] px-3 py-[4px] text-[12px] text-[var(--text-muted)]">Lines {conversation.startLine}-{conversation.line}</div>
      )}
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
      {pr && <ThreadFooter pr={pr} conversation={conversation} />}
    </div>
  )
}

interface DragHandlers {
  onPointerDown: (e: PointerEvent<HTMLButtonElement>) => void
  onPointerMove: (e: PointerEvent<HTMLButtonElement>) => void
  onPointerUp: (e: PointerEvent<HTMLButtonElement>) => void
  onPointerCancel: (e: PointerEvent<HTMLButtonElement>) => void
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void
}

function LineNumber({ n, shown, onPick, drag }: { n: number | null; shown: number | null; onPick: (n: number, e: MouseEvent) => void; drag: (n: number) => DragHandlers }) {
  if (n === null) return <span className="pr-[10px] text-right text-[var(--text-muted)] select-none">{shown ?? ''}</span>
  return (
    <button
      type="button"
      onClick={(e) => onPick(n, e)}
      {...drag(n)}
      aria-label={`Select line ${n}`}
      title="Select line (drag or shift-click for a range)"
      className="cursor-pointer border-none bg-transparent p-0 pr-[10px] text-right [font:inherit] text-[var(--text-muted)] select-none hover:text-[var(--text-primary)]"
    >
      {n}
    </button>
  )
}

function pendingAt(line: DiffLine, c: PendingComment): boolean {
  return lineOn(line, c.side) === c.line
}

export function PrDiff({ pr, file, conversations, now }: { pr: PrSummary; file: PrChangedFile; conversations: PrConversation[]; now: number }) {
  const [sel, setSel] = useState<LineSelection | null>(null)
  const [composing, setComposing] = useState(false)
  const pending = usePendingComments(pr).filter((c) => c.path === file.path)
  // The range a drag in progress would select, drawn over `sel`. `sel` and the comment box (with its
  // text) stay as they are until the drag ends on a new range; Escape just drops the preview.
  const [dragSel, setDragSel] = useState<LineSelection | null>(null)
  // `moved` turns the click that ends a drag into a no-op.
  const dragRef = useRef<{ pointerId: number; sel: LineSelection; range: LineSelection | null; moved: boolean } | null>(null)
  // The click that follows a drag's release is not a pick. A deadline, not a flag: a release
  // click that never comes (pointer let go elsewhere) must not eat a later keyboard click.
  const swallowClickUntil = useRef(0)
  const SWALLOW_CLICK_MS = 1000
  const endDrag = (e: { currentTarget: HTMLButtonElement }, commit: boolean) => {
    const d = dragRef.current
    if (!d) return
    dragRef.current = null
    // A cancelled pointer sends no click, so only a committed drag swallows the next one.
    swallowClickUntil.current = commit && d.moved ? performance.now() + SWALLOW_CLICK_MS : 0
    if (e.currentTarget.hasPointerCapture(d.pointerId)) e.currentTarget.releasePointerCapture(d.pointerId)
    setDragSel(null)
    if (!commit) return
    const next = afterDrag({ sel, composing }, d.range)
    setSel(next.sel)
    setComposing(next.composing)
  }
  const drag = (side: 'new' | 'old', hunk: number) => (n: number): DragHandlers => ({
    onPointerDown: (e) => {
      swallowClickUntil.current = 0
      if (e.button !== 0 || e.shiftKey) return
      // No text selection across the code while dragging; focus by hand since preventDefault skips it.
      e.preventDefault()
      e.currentTarget.focus()
      e.currentTarget.setPointerCapture(e.pointerId)
      dragRef.current = { pointerId: e.pointerId, sel: { side, hunk, anchor: n, start: n, end: n }, range: null, moved: false }
    },
    onPointerMove: (e) => {
      const d = dragRef.current
      if (!d || d.pointerId !== e.pointerId) return
      // ponytail: scrolls only while the pointer moves near an edge (the top band clears the sticky file header), add a timer if holding still should scroll too.
      const scroller = e.currentTarget.closest('[data-pr-diff]')?.parentElement
      if (scroller) {
        const box = scroller.getBoundingClientRect()
        if (e.clientY < box.top + 48) scroller.scrollBy(0, -20)
        else if (e.clientY > box.bottom - 24) scroller.scrollBy(0, 20)
      }
      const row = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-diff-hunk]')
      if (!row) return
      const at = row.dataset[d.sel.side === 'old' ? 'oldLine' : 'newLine']
      const next = dragLineSelection(d.sel, file.hunks[d.sel.hunk], Number(row.dataset.diffHunk), at === undefined ? null : Number(at))
      if (!d.moved && next.start === next.end) return
      d.moved = true
      d.range = next
      setDragSel(next)
    },
    onPointerUp: (e) => endDrag(e, true),
    onPointerCancel: (e) => endDrag(e, false),
    onKeyDown: (e) => {
      const d = dragRef.current
      if (e.key !== 'Escape' || !d) return
      e.stopPropagation()
      endDrag(e, false)
      swallowClickUntil.current = performance.now() + SWALLOW_CLICK_MS
    },
  })
  const pick = (side: 'new' | 'old', hunk: number, n: number, e: MouseEvent) => {
    if (performance.now() < swallowClickUntil.current) {
      swallowClickUntil.current = 0
      return
    }
    setComposing(false)
    setSel((prev) => nextLineSelection(prev, side, hunk, n, e.shiftKey))
  }
  const inRange = (r: LineSelection | null, line: DiffLine, hunk: number) => {
    if (!r || r.hunk !== hunk) return false
    const n = lineOn(line, r.side)
    return n !== null && n >= r.start && n <= r.end
  }
  const ask = () => {
    if (!sel) return
    const diff = diffAround(file, sel.side, sel.start, sel.end, 0)
    if (!diff) return
    void askAgent({ pr: pr.ref, title: pr.title, url: pr.url, items: [{ kind: 'lines', path: file.path, side: sel.side, startLine: sel.start, endLine: sel.end, diff }] })
    setSel(null)
  }
  const closeComment = () => {
    setComposing(false)
    setSel(null)
  }
  const placed = new Set<string>()
  const placedPending = new Set<string>()
  const rows = file.hunks.flatMap((hunk, h) => [
    <div key={`h${h}`} className="w-max min-w-full bg-[var(--bg-tertiary)] px-[14px] py-[2px] text-[var(--text-muted)]">{hunk.header}</div>,
    ...hunk.lines.flatMap((line, i) => {
      const here = conversations.filter((c) => !placed.has(c.id) && anchoredTo(line, c))
      for (const c of here) placed.add(c.id)
      const heldHere = pending.filter((c) => !placedPending.has(c.id) && pendingAt(line, c))
      for (const c of heldHere) placedPending.add(c.id)
      const isSel = inRange(dragSel ?? sel, line, h)
      const lastSel = inRange(sel, line, h) && sel !== null && lineOn(line, sel.side) === sel.end
      return [
        <div
          key={`h${h}l${i}`}
          data-diff-line={line.kind}
          data-diff-hunk={h}
          data-old-line={lineOn(line, 'old') ?? undefined}
          data-new-line={lineOn(line, 'new') ?? undefined}
          aria-selected={isSel || undefined}
          className={cn(
            // As wide as its own text, never narrower than the pane: a scrolled long line keeps its colour.
            'grid w-max min-w-full grid-cols-[48px_48px_18px_1fr] whitespace-pre',
            line.kind === 'add' && 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)]',
            line.kind === 'del' && 'bg-[color-mix(in_srgb,var(--error)_14%,transparent)]',
            isSel && 'bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] shadow-[inset_3px_0_0_var(--accent)]',
          )}
        >
          <LineNumber n={lineOn(line, 'old')} shown={line.oldLine} onPick={(n, e) => pick('old', h, n, e)} drag={drag('old', h)} />
          <LineNumber n={lineOn(line, 'new')} shown={line.newLine} onPick={(n, e) => pick('new', h, n, e)} drag={drag('new', h)} />
          <span className={cn('select-none', line.kind === 'context' ? 'text-[var(--text-muted)]' : line.kind === 'add' ? 'text-[var(--success)]' : 'text-[var(--error)]')}>
            {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
          </span>
          <span className="pr-[14px]">{line.text}</span>
        </div>,
        ...(lastSel && !composing ? [
          <div key={`h${h}l${i}sel`} className="relative h-0">
            <div className="absolute top-[2px] left-[114px] z-[3] flex gap-1 rounded-[8px] border border-[var(--border-strong,var(--border))] bg-[var(--bg-surface)] p-1 font-[family-name:var(--font-sans)] shadow-[0_8px_24px_rgba(0,0,0,0.4)]">
              <Button variant="outline" size="sm" onClick={() => setComposing(true)}><Icon name="msg" />Comment</Button>
              <Button variant="outline" size="sm" onClick={ask}><Icon name="spark" />Ask the agent</Button>
            </div>
          </div>,
        ] : []),
        ...(lastSel && composing && sel ? [
          <LineCommentBox
            key={`h${h}l${i}comment`}
            pr={pr}
            target={{ path: file.path, side: sel.side, line: sel.end, ...(sel.start < sel.end ? { startLine: sel.start } : {}) }}
            onClose={closeComment}
          />,
        ] : []),
        ...here.map((c) => <ConversationThread key={c.id} conversation={c} now={now} pr={pr} showRange className="mt-2 mr-4 mb-3 ml-[114px]" />),
        ...heldHere.map((c) => <PendingCommentCard key={c.id} pr={pr} comment={c} />),
      ]
    }),
  ])
  const unplaced = conversations.filter((c) => !placed.has(c.id))

  return (
    <div data-pr-diff>
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
          {unplaced.map((c) => <ConversationThread key={c.id} conversation={c} now={now} pr={pr} className="mb-3" />)}
        </div>
      )}
    </div>
  )
}
